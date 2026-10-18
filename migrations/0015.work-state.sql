BEGIN;
-- P06.T01a work state (ADR-0010 items 1-2). Executes AS morrow_work_owner, after
-- 0014. Tenant data pattern: composite tenant keys, FORCE RLS on every table,
-- read and write policies against morrow_work.current_tenant(), definer API
-- functions owned by morrow_work_command (itself subject to the tenant policies),
-- INVOKER helpers and triggers granted to nobody. No external effect: tasks reach
-- only draft or ready, and there are no operations, runs or dispatch.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api') AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication)<>3
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='morrow_api_worker' AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication)
 -- Exactly the two reviewed memberships among the work roles (inherit false, set
 -- true), plus at most one PG16+ CREATEROLE provisioning row per role whose
 -- member is not a Morrow role (admin true, inherit false, set false).
 OR (SELECT count(*) FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid=m.roleid JOIN pg_catalog.pg_roles u ON u.oid=m.member
   WHERE (g.rolname,u.rolname) IN (('morrow_work_api','morrow_api_worker'),('morrow_work_command','morrow_work_owner'))
   AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option)<>2
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid=m.roleid JOIN pg_catalog.pg_roles u ON u.oid=m.member
   WHERE (g.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker') OR u.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker'))
   AND (g.rolname,u.rolname) NOT IN (('morrow_work_api','morrow_api_worker'),('morrow_work_command','morrow_work_owner'))
   AND NOT (u.rolname NOT LIKE 'morrow\_%' AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles w,pg_catalog.pg_roles i
   WHERE w.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker')
   AND (i.rolname='morrow_api' OR i.rolname LIKE 'morrow\_identity%')
   AND (pg_catalog.pg_has_role(w.oid,i.oid,'MEMBER') OR pg_catalog.pg_has_role(i.oid,w.oid,'MEMBER')))
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_session_context(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_actor_authority(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_lock_and_recheck(text,text,text,text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_member_authority(text,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'WORK_ROLE_PREREQUISITES_INVALID'; END IF;
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE morrow_work_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE SCHEMA morrow_work AUTHORIZATION morrow_work_owner;
REVOKE ALL ON SCHEMA morrow_work FROM PUBLIC;
GRANT USAGE ON SCHEMA morrow_work TO morrow_work_command,morrow_work_api;

CREATE DOMAIN morrow_work.record_id AS text CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
CREATE DOMAIN morrow_work.revision AS bigint CHECK (VALUE BETWEEN 1 AND 9007199254740991);
CREATE DOMAIN morrow_work.digest AS text CHECK (VALUE ~ '^[a-f0-9]{64}$');

-- IMMUTABLE row checks. CHECK constraints run with the writer's privileges, so the
-- command role (the only runtime writer) holds EXECUTE on these two, and nothing else.
-- Scope: exactly the six Scope keys, this tenant, no stores, accounts or fields, and
-- resources [] or exactly [W].
CREATE FUNCTION morrow_work.valid_scope(s jsonb,org text,ws text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN s IS NULL OR org IS NULL OR ws IS NULL OR jsonb_typeof(s)<>'object' THEN false ELSE
  s ?& ARRAY['organizationId','workspaceId','storeIds','accountIds','resources','fields']
  AND (s-ARRAY['organizationId','workspaceId','storeIds','accountIds','resources','fields'])='{}'::jsonb
  AND s->'organizationId'=to_jsonb(org) AND s->'workspaceId'=to_jsonb(ws)
  AND s->'storeIds'='[]'::jsonb AND s->'accountIds'='[]'::jsonb AND s->'fields'='[]'::jsonb
  AND (s->'resources'='[]'::jsonb OR s->'resources'=jsonb_build_array(jsonb_build_object(
   'organizationId',org,'workspaceId',ws,'storeId',NULL,'connectionId',NULL,'kind','workspace','id',ws)))
 END
$$;
-- Success criteria: 1..20 exact {description 1..2048 chars, verificationCapabilityId
-- CapabilityId|null, evidenceRequired boolean}.
CREATE FUNCTION morrow_work.valid_criteria(c jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN c IS NULL OR jsonb_typeof(c)<>'array' THEN false
  WHEN jsonb_array_length(c) NOT BETWEEN 1 AND 20 THEN false ELSE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(c) e WHERE NOT (CASE WHEN jsonb_typeof(e)<>'object' THEN false ELSE
   e ?& ARRAY['description','verificationCapabilityId','evidenceRequired']
   AND (e-ARRAY['description','verificationCapabilityId','evidenceRequired'])='{}'::jsonb
   AND jsonb_typeof(e->'description')='string' AND char_length(e->>'description') BETWEEN 1 AND 2048
   AND (e->'verificationCapabilityId'='null'::jsonb OR (jsonb_typeof(e->'verificationCapabilityId')='string'
     AND char_length(e->>'verificationCapabilityId') BETWEEN 1 AND 128
     AND (e->>'verificationCapabilityId') ~ '^[a-z]+(\.[a-z_]+)+$'))
   AND jsonb_typeof(e->'evidenceRequired')='boolean' END)) END
$$;
REVOKE ALL ON FUNCTION morrow_work.valid_scope(jsonb,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.valid_criteria(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.valid_scope(jsonb,text,text),morrow_work.valid_criteria(jsonb) TO morrow_work_command;

-- Platform: the goal, task and question rows of state-transitions.json v1. Rows a
-- later contract version adds (since 1.1) are persisted by later P06 migrations.
CREATE TABLE morrow_work.transition_rules (
 machine text NOT NULL CHECK (machine IN ('goal','task','question')),
 from_status text NOT NULL CHECK (from_status ~ '^[a-z_]{1,32}$'),
 to_status text NOT NULL CHECK (to_status ~ '^[a-z_]{1,32}$'),
 actor text NOT NULL CHECK (actor ~ '^[a-z_]{1,32}$'),
 guard text NOT NULL CHECK (guard ~ '^[a-z_]{1,64}$'),
 PRIMARY KEY (machine,from_status,to_status,actor)
);
INSERT INTO morrow_work.transition_rules(machine,from_status,to_status,actor,guard) VALUES
 ('goal','draft','active','owner','scope_and_success_criteria'),
 ('goal','active','paused','owner','current_revision'),
 ('goal','paused','active','owner','current_grants'),
 ('goal','active','achieved','owner','accepted_completion_evidence'),
 ('goal','draft','cancelled','owner','current_revision'),
 ('goal','active','cancelled','owner','child_cancellation_reconciled'),
 ('goal','paused','cancelled','owner','child_cancellation_reconciled'),
 ('task','draft','ready','owner','inputs_and_scope_valid'),
 ('task','ready','queued','work_service','dispatch_eligible'),
 ('task','queued','running','runtime','current_lease_and_grants'),
 ('task','running','waiting_input','work_service','open_blocking_question'),
 ('task','running','waiting_approval','work_service','immutable_pending_proposal'),
 ('task','waiting_input','queued','work_service','eligible_answer_committed'),
 ('task','waiting_approval','queued','work_service','exact_current_approval'),
 ('task','running','paused','owner','stop_new_dispatch'),
 ('task','queued','paused','owner','stop_new_dispatch'),
 ('task','waiting_input','paused','owner','stop_new_dispatch'),
 ('task','waiting_approval','paused','owner','stop_new_dispatch'),
 ('task','paused','queued','owner','current_grants_and_budget'),
 ('task','running','succeeded','work_service','accepted_completion_evidence'),
 ('task','running','failed','work_service','reconciled_failure_evidence'),
 ('task','queued','cancelling','owner','cancel_requested'),
 ('task','running','cancelling','owner','cancel_requested'),
 ('task','waiting_input','cancelling','owner','cancel_requested'),
 ('task','waiting_approval','cancelling','owner','cancel_requested'),
 ('task','paused','cancelling','owner','cancel_requested'),
 ('task','cancelling','cancelled','work_service','submitted_effects_and_liabilities_reconciled'),
 ('question','open','answered','eligible_respondent','answer_matches_schema_and_revision'),
 ('question','open','cancelled','owner','current_revision'),
 ('question','open','expired','work_service','expiry_elapsed');

-- Tenant-internal: the per-workspace serialization row and outbox head.
CREATE TABLE morrow_work.workspace_streams (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 head_position bigint NOT NULL DEFAULT 0 CHECK (head_position BETWEEN 0 AND 9007199254740991),
 created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id)
);
CREATE TABLE morrow_work.goals (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 status text NOT NULL CHECK (status IN ('draft','active','paused','achieved','cancelled')),
 objective text NOT NULL CHECK (char_length(objective) BETWEEN 1 AND 8192),
 scope jsonb NOT NULL,
 success_criteria jsonb NOT NULL,
 owner_principal_id morrow_work.record_id NOT NULL,
 owner_membership_id morrow_work.record_id NOT NULL,
 created_by_principal_id morrow_work.record_id NOT NULL,
 created_by_membership_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (isfinite(updated_at) AND updated_at>=created_at),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_work.workspace_streams(organization_id,workspace_id),
 FOREIGN KEY (organization_id,owner_membership_id,owner_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,owner_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (organization_id,created_by_membership_id,created_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,created_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT goals_valid_scope CHECK (morrow_work.valid_scope(scope,organization_id,workspace_id)),
 CONSTRAINT goals_valid_criteria CHECK (morrow_work.valid_criteria(success_criteria))
);
-- v1 tasks reach only draft or ready; P06.T03 widens this in a forward migration.
CREATE TABLE morrow_work.tasks (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 goal_id morrow_work.record_id NOT NULL,
 status text NOT NULL CHECK (status IN ('draft','ready')),
 objective text NOT NULL CHECK (char_length(objective) BETWEEN 1 AND 8192),
 scope jsonb NOT NULL,
 initiator_principal_id morrow_work.record_id NOT NULL,
 initiator_membership_id morrow_work.record_id NOT NULL,
 owner_principal_id morrow_work.record_id NOT NULL,
 owner_membership_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (isfinite(updated_at) AND updated_at>=created_at),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,goal_id) REFERENCES morrow_work.goals(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,initiator_membership_id,initiator_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,initiator_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (organization_id,owner_membership_id,owner_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,owner_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT tasks_valid_scope CHECK (morrow_work.valid_scope(scope,organization_id,workspace_id))
);
CREATE INDEX tasks_goal ON morrow_work.tasks (organization_id,workspace_id,goal_id,created_at,id);
CREATE INDEX tasks_owner ON morrow_work.tasks (organization_id,workspace_id,owner_principal_id,status);
CREATE INDEX tasks_created ON morrow_work.tasks (organization_id,workspace_id,created_at,id);
CREATE INDEX goals_created ON morrow_work.goals (organization_id,workspace_id,created_at,id);
-- Tenant-internal assignment history.
CREATE TABLE morrow_work.task_assignments (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 task_id morrow_work.record_id NOT NULL,
 assignee_principal_id morrow_work.record_id NOT NULL,
 assignee_membership_id morrow_work.record_id NOT NULL,
 assigned_by_principal_id morrow_work.record_id NOT NULL,
 assigned_by_membership_id morrow_work.record_id NOT NULL,
 task_revision morrow_work.revision NOT NULL,
 created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,assignee_membership_id,assignee_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,assignee_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (organization_id,assigned_by_membership_id,assigned_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,assigned_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id)
);
-- The answer schema is the built-in morrow.answer.text; no expiry or blocking
-- columns until P06.T03.
CREATE TABLE morrow_work.questions (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 task_id morrow_work.record_id NOT NULL,
 status text NOT NULL CHECK (status IN ('open','answered','cancelled','expired')),
 prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 8192),
 requester_principal_id morrow_work.record_id NOT NULL,
 requester_membership_id morrow_work.record_id NOT NULL,
 respondent_principal_id morrow_work.record_id NOT NULL,
 respondent_membership_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (isfinite(updated_at) AND updated_at>=created_at),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,requester_membership_id,requester_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,requester_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (organization_id,respondent_membership_id,respondent_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,respondent_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id)
);
CREATE INDEX questions_open_respondent ON morrow_work.questions (organization_id,workspace_id,respondent_principal_id,created_at,id) WHERE status='open';
CREATE INDEX questions_task ON morrow_work.questions (organization_id,workspace_id,task_id,created_at,id);
CREATE TABLE morrow_work.question_answers (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 question_id morrow_work.record_id NOT NULL,
 body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8192),
 body_digest morrow_work.digest NOT NULL,
 answered_by_principal_id morrow_work.record_id NOT NULL,
 answered_by_membership_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,question_id),
 FOREIGN KEY (organization_id,workspace_id,question_id) REFERENCES morrow_work.questions(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,answered_by_membership_id,answered_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,answered_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CHECK (body_digest=encode(sha256(convert_to(body,'UTF8')),'hex'))
);
-- Idempotency keys are scoped per actor; the row commits atomically with the effect.
CREATE TABLE morrow_work.commands (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 actor_principal_id morrow_work.record_id NOT NULL,
 command_id morrow_work.record_id NOT NULL,
 actor_membership_id morrow_work.record_id NOT NULL,
 request_digest morrow_work.digest NOT NULL,
 command_type text NOT NULL CHECK (command_type IN ('goal.create','goal.transition','task.create','task.ready','task.assign','question.request','question.answer','question.cancel')),
 aggregate_type text NOT NULL CHECK (aggregate_type IN ('goal','task','question') AND aggregate_type=split_part(command_type,'.',1)),
 aggregate_id morrow_work.record_id NOT NULL,
 aggregate_revision morrow_work.revision NOT NULL,
 result jsonb NOT NULL CHECK (jsonb_typeof(result)='object' AND pg_column_size(result)<=1024),
 correlation_id morrow_work.record_id NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
 PRIMARY KEY (organization_id,workspace_id,actor_principal_id,command_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_work.workspace_streams(organization_id,workspace_id),
 FOREIGN KEY (organization_id,actor_membership_id,actor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id)
);
-- Write side only until P06.T02a. Positions are gap-free and commit-ordered per
-- workspace; aggregate revisions order each aggregate. Payloads carry IDs and
-- statuses only, from a fixed allowlist per event type.
CREATE TABLE morrow_work.outbox_events (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 position bigint NOT NULL CHECK (position BETWEEN 1 AND 9007199254740991),
 event_id uuid NOT NULL UNIQUE,
 event_type text NOT NULL CHECK (event_type IN ('goal.created','goal.status_changed','task.created','task.status_changed','task.assigned','question.requested','question.answered','question.cancelled')),
 aggregate_type text NOT NULL CHECK (aggregate_type IN ('goal','task','question') AND aggregate_type=split_part(event_type,'.',1)),
 aggregate_id morrow_work.record_id NOT NULL,
 aggregate_revision morrow_work.revision NOT NULL,
 task_id morrow_work.record_id,
 correlation_id morrow_work.record_id NOT NULL,
 causation_id morrow_work.record_id CHECK (causation_id IS NULL),
 actor_principal_id morrow_work.record_id NOT NULL,
 actor_membership_id morrow_work.record_id NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND pg_column_size(payload)<=512),
 payload_digest morrow_work.digest NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,position),
 UNIQUE (organization_id,workspace_id,aggregate_type,aggregate_id,aggregate_revision),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_work.workspace_streams(organization_id,workspace_id),
 CHECK ((aggregate_type='goal' AND task_id IS NULL) OR (aggregate_type='task' AND task_id=aggregate_id) OR (aggregate_type='question' AND task_id IS NOT NULL)),
 CHECK (payload_digest=encode(sha256(convert_to(payload::text,'UTF8')),'hex')),
 CHECK (CASE WHEN jsonb_typeof(payload)<>'object' THEN false
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
  ELSE false END)
);

-- Row security. Every table: ENABLE + FORCE and a maintenance-only owner policy.
-- Tenant tables: the command role's read/write policy. Tenant-readable tables: the
-- api role's read policy. One InitPlan and a row comparison against current_tenant().
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['transition_rules','workspace_streams','goals','tasks','task_assignments','questions','question_answers','commands','outbox_events'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
 END LOOP;
END $$;
CREATE POLICY platform_command_read ON morrow_work.transition_rules FOR SELECT TO morrow_work_command USING (true);
GRANT SELECT ON morrow_work.transition_rules TO morrow_work_command;

-- Resolver-validated tenant context. The digest travels only as a bind parameter
-- into transaction-local settings; every evaluation re-resolves it through
-- session_eligibility(), so a forged setting yields zero rows.
CREATE FUNCTION morrow_work.current_tenant()
RETURNS TABLE(organization_id text,workspace_id text,principal_id text,membership_id text,policy_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT c.organization_id,c.workspace_id,c.principal_id,c.membership_id,c.policy_revision
 FROM morrow_identity.work_session_context(
  pg_catalog.current_setting('morrow.work_session_digest',true),
  pg_catalog.current_setting('morrow.work_workspace',true)) c
$$;
REVOKE ALL ON FUNCTION morrow_work.current_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.current_tenant() TO morrow_work_api;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['workspace_streams','goals','tasks','task_assignments','questions','question_answers','commands','outbox_events'] LOOP
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('GRANT SELECT,INSERT ON morrow_work.%I TO morrow_work_command',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['goals','tasks','questions','question_answers'] LOOP
  EXECUTE format('CREATE POLICY tenant_read ON morrow_work.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
END $$;
-- Runtime UPDATE is column-scoped; there is no runtime DELETE or TRUNCATE.
GRANT UPDATE (head_position) ON morrow_work.workspace_streams TO morrow_work_command;
GRANT UPDATE (status,revision,updated_at) ON morrow_work.goals TO morrow_work_command;
GRANT UPDATE (status,revision,updated_at,owner_principal_id,owner_membership_id) ON morrow_work.tasks TO morrow_work_command;
GRANT UPDATE (status,revision,updated_at) ON morrow_work.questions TO morrow_work_command;
-- The api role reads tenant-readable tables only, column by column.
GRANT SELECT (organization_id,workspace_id,id,revision,status,objective,scope,success_criteria,owner_principal_id,owner_membership_id,created_by_principal_id,created_by_membership_id,created_at,updated_at) ON morrow_work.goals TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,revision,goal_id,status,objective,scope,initiator_principal_id,initiator_membership_id,owner_principal_id,owner_membership_id,created_at,updated_at) ON morrow_work.tasks TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,revision,task_id,status,prompt,requester_principal_id,requester_membership_id,respondent_principal_id,respondent_membership_id,created_at,updated_at) ON morrow_work.questions TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,question_id,body,body_digest,answered_by_principal_id,answered_by_membership_id,created_at) ON morrow_work.question_answers TO morrow_work_api;

-- Triggers: INVOKER, owned by morrow_work_owner, granted to nobody.
CREATE FUNCTION morrow_work.enforce_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE
 v_machine text; v_initial text; v_mutable text[];
BEGIN
 v_machine:=CASE TG_TABLE_NAME WHEN 'goals' THEN 'goal' WHEN 'tasks' THEN 'task' WHEN 'questions' THEN 'question' END;
 v_initial:=CASE v_machine WHEN 'question' THEN 'open' ELSE 'draft' END;
 v_mutable:=CASE v_machine WHEN 'task' THEN ARRAY['status','revision','updated_at','owner_principal_id','owner_membership_id']
  ELSE ARRAY['status','revision','updated_at'] END;
 IF v_machine IS NULL THEN RAISE EXCEPTION 'WORK_STATE_INVALID'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>v_initial OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'WORK_STATE_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.updated_at<OLD.updated_at
  OR (NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules r
   WHERE r.machine=v_machine AND r.from_status=OLD.status AND r.to_status=NEW.status)) THEN
  RAISE EXCEPTION 'WORK_STATE_INVALID';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION morrow_work.append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'WORK_RECORD_IMMUTABLE';
END $$;
CREATE FUNCTION morrow_work.stream_advance() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR NEW.head_position IS DISTINCT FROM OLD.head_position+1
  OR (to_jsonb(NEW)-'head_position') IS DISTINCT FROM (to_jsonb(OLD)-'head_position') THEN
  RAISE EXCEPTION 'WORK_RECORD_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.enforce_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.stream_advance() FROM PUBLIC;
CREATE TRIGGER enforce_status BEFORE INSERT OR UPDATE ON morrow_work.goals FOR EACH ROW EXECUTE FUNCTION morrow_work.enforce_status();
CREATE TRIGGER enforce_status BEFORE INSERT OR UPDATE ON morrow_work.tasks FOR EACH ROW EXECUTE FUNCTION morrow_work.enforce_status();
CREATE TRIGGER enforce_status BEFORE INSERT OR UPDATE ON morrow_work.questions FOR EACH ROW EXECUTE FUNCTION morrow_work.enforce_status();
CREATE TRIGGER stream_advance BEFORE UPDATE ON morrow_work.workspace_streams FOR EACH ROW EXECUTE FUNCTION morrow_work.stream_advance();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['transition_rules','commands','outbox_events','task_assignments','question_answers'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['workspace_streams','goals','tasks','questions'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['transition_rules','workspace_streams','goals','tasks','task_assignments','questions','question_answers','commands','outbox_events'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- Helpers: owned by the command role (after the transfer below), INVOKER, granted
-- to nobody. They run under the command role's tenant policies.
-- The shared prelude of every command: (a) scalars, (b) tenant and actor from
-- current_tenant() and the enter_context snapshot, the per-actor key lock, (c) the
-- command row, (d) the locked freshness recheck, (e) the workspace stream lock.
CREATE FUNCTION morrow_work.command_prelude(p_command_id text,p_request_digest text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,principal_id text,membership_id text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 t record; v_check text;
BEGIN
 IF p_command_id IS NULL OR p_command_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_request_digest IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT c.organization_id,c.workspace_id,c.principal_id,c.membership_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF t.principal_id IS DISTINCT FROM pg_catalog.current_setting('morrow.work_principal_id',true)
  OR t.membership_id IS DISTINCT FROM pg_catalog.current_setting('morrow.work_membership_id',true) THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.work.command',t.organization_id,t.workspace_id,t.principal_id,p_command_id)::text,0));
 IF EXISTS(SELECT 1 FROM morrow_work.commands c WHERE c.organization_id=t.organization_id AND c.workspace_id=t.workspace_id
   AND c.actor_principal_id=t.principal_id AND c.command_id=p_command_id) THEN
  RETURN QUERY SELECT 'command_conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_check:=morrow_identity.work_lock_and_recheck(
  pg_catalog.current_setting('morrow.work_session_digest',true),pg_catalog.current_setting('morrow.work_workspace',true),
  pg_catalog.current_setting('morrow.work_principal_id',true),pg_catalog.current_setting('morrow.work_membership_id',true),
  pg_catalog.current_setting('morrow.work_policy_revision',true),pg_catalog.current_setting('morrow.work_grants_digest',true),
  pg_catalog.current_setting('morrow.work_evaluated_at_us',true));
 IF v_check='ineligible' THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 ELSIF v_check IS DISTINCT FROM 'current' THEN
  RETURN QUERY SELECT 'stale_authority'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 INSERT INTO morrow_work.workspace_streams(organization_id,workspace_id,head_position,created_at)
  VALUES (t.organization_id,t.workspace_id,0,clock_timestamp()) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM morrow_work.workspace_streams s WHERE s.organization_id=t.organization_id AND s.workspace_id=t.workspace_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'ok'::text,t.organization_id,t.workspace_id,t.principal_id,t.membership_id;
END $$;
-- The outbox append: the stream row is already locked, so positions are gap-free
-- and follow commit order.
CREATE FUNCTION morrow_work.append_event(p_org text,p_ws text,p_principal text,p_membership text,p_event_type text,
 p_aggregate_type text,p_aggregate_id text,p_aggregate_revision bigint,p_task_id text,p_payload jsonb,p_correlation_id text,p_at timestamptz)
RETURNS bigint
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_position bigint;
BEGIN
 UPDATE morrow_work.workspace_streams s SET head_position=s.head_position+1
  WHERE s.organization_id=p_org AND s.workspace_id=p_ws RETURNING s.head_position INTO v_position;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORK_STREAM_MISSING'; END IF;
 INSERT INTO morrow_work.outbox_events(organization_id,workspace_id,position,event_id,event_type,aggregate_type,aggregate_id,
  aggregate_revision,task_id,correlation_id,causation_id,actor_principal_id,actor_membership_id,occurred_at,payload,payload_digest)
 VALUES (p_org,p_ws,v_position,gen_random_uuid(),p_event_type,p_aggregate_type,p_aggregate_id,p_aggregate_revision,p_task_id,
  p_correlation_id,NULL,p_principal,p_membership,p_at,p_payload,encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'));
 RETURN v_position;
END $$;
CREATE FUNCTION morrow_work.record_command(p_org text,p_ws text,p_principal text,p_membership text,p_command_id text,
 p_request_digest text,p_type text,p_aggregate_id text,p_aggregate_revision bigint,p_result jsonb,p_correlation_id text,p_at timestamptz)
RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 INSERT INTO morrow_work.commands(organization_id,workspace_id,actor_principal_id,command_id,actor_membership_id,request_digest,
  command_type,aggregate_type,aggregate_id,aggregate_revision,result,correlation_id,recorded_at)
 VALUES (p_org,p_ws,p_principal,p_command_id,p_membership,p_request_digest,p_type,split_part(p_type,'.',1),
  p_aggregate_id,p_aggregate_revision,p_result,p_correlation_id,p_at);
END $$;

-- API functions: SECURITY DEFINER, owned by the command role after the transfer
-- below, EXECUTE for morrow_work_api only. None takes an organization, workspace or
-- actor parameter except enter_context(digest, workspace), which resolves both
-- through session_eligibility().
CREATE FUNCTION morrow_work.enter_context(p_digest text,p_workspace text)
RETURNS TABLE(principal_id text,organization_id text,workspace_id text,membership_id text,policy_revision text,
 grants text,grant_count text,grants_digest text,database_now_us text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 a record; v_us bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user AND r.rolname='morrow_api_worker'
   AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolinherit) THEN
  RETURN;
 END IF;
 IF COALESCE(pg_catalog.current_setting('morrow.work_session_digest',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_workspace',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_principal_id',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_membership_id',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_policy_revision',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_grants_digest',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_evaluated_at_us',true),'')<>'' THEN
  RETURN;
 END IF;
 IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_workspace IS NULL OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN;
 END IF;
 SELECT * INTO a FROM morrow_identity.work_actor_authority(p_digest,p_workspace);
 IF NOT FOUND THEN RETURN; END IF;
 v_us:=(extract(epoch FROM a.database_now)*1000000)::bigint;
 PERFORM pg_catalog.set_config('morrow.work_session_digest',p_digest,true),
  pg_catalog.set_config('morrow.work_workspace',p_workspace,true),
  pg_catalog.set_config('morrow.work_principal_id',a.principal_id,true),
  pg_catalog.set_config('morrow.work_membership_id',a.membership_id,true),
  pg_catalog.set_config('morrow.work_policy_revision',a.policy_revision::text,true),
  pg_catalog.set_config('morrow.work_grants_digest',a.grants_digest,true),
  pg_catalog.set_config('morrow.work_evaluated_at_us',(v_us-(v_us%1000))::text,true);
 RETURN QUERY SELECT a.principal_id,a.organization_id,a.workspace_id,a.membership_id,a.policy_revision::text,
  a.grants::text,a.grant_count::text,a.grants_digest,v_us::text;
END $$;
-- Replay first: the per-actor key lock, then the recorded command if any.
CREATE FUNCTION morrow_work.begin_command(p_type text,p_command_id text,p_request_digest text)
RETURNS TABLE(outcome text,aggregate_type text,aggregate_id text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 t record; c record;
BEGIN
 IF p_type IS NULL OR p_type NOT IN ('goal.create','goal.transition','task.create','task.ready','task.assign','question.request','question.answer','question.cancel')
  OR p_command_id IS NULL OR p_command_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_request_digest IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.organization_id,x.workspace_id,x.principal_id INTO t FROM morrow_work.current_tenant() x;
 IF NOT FOUND THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.work.command',t.organization_id,t.workspace_id,t.principal_id,p_command_id)::text,0));
 SELECT k.request_digest::text AS request_digest,k.aggregate_type,k.aggregate_id::text AS aggregate_id,k.result::text AS result INTO c
  FROM morrow_work.commands k WHERE k.organization_id=t.organization_id AND k.workspace_id=t.workspace_id
  AND k.actor_principal_id=t.principal_id AND k.command_id=p_command_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'new'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF c.request_digest<>p_request_digest THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'replay'::text,c.aggregate_type,c.aggregate_id,c.result;
END $$;
-- Eligibility facts of an assignee or respondent in the caller's own workspace,
-- with the digest of those grants (the actor's grants_digest rule), which the
-- command passes back so the target is rechecked under the organization lock.
CREATE FUNCTION morrow_work.target_member(p_target_principal_id text)
RETURNS TABLE(membership_id text,grants text,grant_count text,grants_digest text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 IF p_target_principal_id IS NULL OR p_target_principal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 SELECT x.organization_id,x.workspace_id INTO t FROM morrow_work.current_tenant() x;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT m.membership_id,m.grants::text,m.grant_count::text,encode(sha256(convert_to(m.grants::text,'UTF8')),'hex')
  FROM morrow_identity.work_member_authority(t.organization_id,t.workspace_id,p_target_principal_id) m;
END $$;
-- The locked recheck of an assignee or respondent (ADR-0010 item 4: the target
-- currently holds the grants it was judged on). Called after command_prelude, so
-- under the organization interlock: 'not_found' when the target is no longer an
-- eligible member; 'stale_authority' when its grants digest changed or one of its
-- grants expired after the snapshot instant (work_lock_and_recheck's rule).
CREATE FUNCTION morrow_work.target_recheck(p_org text,p_ws text,p_principal text,p_grants_digest text)
RETURNS TABLE(outcome text,membership_id text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 m record; v_us text; v_evaluated timestamptz; v_now timestamptz; v_expired boolean;
BEGIN
 SELECT x.membership_id,x.grants INTO m FROM morrow_identity.work_member_authority(p_org,p_ws,p_principal) x;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 v_us:=pg_catalog.current_setting('morrow.work_evaluated_at_us',true);
 IF p_grants_digest IS NULL OR encode(sha256(convert_to(m.grants::text,'UTF8')),'hex')<>p_grants_digest
  OR v_us IS NULL OR v_us !~ '^[1-9][0-9]{0,17}$' THEN
  RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN;
 END IF;
 v_evaluated:=timestamptz 'epoch'+(v_us||' microseconds')::interval;
 v_now:=clock_timestamp();
 IF v_evaluated>v_now THEN RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN; END IF;
 BEGIN
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(m.grants) g
   WHERE g->'expiresAt'<>'null'::jsonb
     AND (g->>'expiresAt')::timestamptz>v_evaluated AND (g->>'expiresAt')::timestamptz<=v_now)
  INTO v_expired;
 EXCEPTION WHEN OTHERS THEN v_expired:=NULL;
 END;
 IF v_expired IS NOT FALSE THEN RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'current'::text,m.membership_id;
END $$;

CREATE FUNCTION morrow_work.cmd_goal_create(p_command_id text,p_request_digest text,p_correlation_id text,p_objective text,p_success_criteria text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; v_criteria jsonb; v_id text; v_at timestamptz; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_objective IS NULL OR char_length(p_objective) NOT BETWEEN 1 AND 8192
  OR p_success_criteria IS NULL OR octet_length(p_success_criteria)>65536 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 BEGIN v_criteria:=p_success_criteria::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 IF NOT morrow_work.valid_criteria(v_criteria) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 IF (SELECT count(*) FROM morrow_work.goals g WHERE g.organization_id=p.organization_id AND g.workspace_id=p.workspace_id)>=10000 THEN
  RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
 END IF;
 v_id:=gen_random_uuid()::text; v_at:=clock_timestamp();
 INSERT INTO morrow_work.goals(organization_id,workspace_id,id,revision,status,objective,scope,success_criteria,
  owner_principal_id,owner_membership_id,created_by_principal_id,created_by_membership_id,created_at,updated_at)
 VALUES (p.organization_id,p.workspace_id,v_id,1,'draft',p_objective,
  jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
   'resources',jsonb_build_array(jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeId',NULL,
    'connectionId',NULL,'kind','workspace','id',p.workspace_id)),'fields','[]'::jsonb),
  v_criteria,p.principal_id,p.membership_id,p.principal_id,p.membership_id,v_at,v_at);
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'goal.created','goal',v_id,1,NULL,
  jsonb_build_object('status','draft'),p_correlation_id,v_at);
 v_result:=jsonb_build_object('goalId',v_id,'revision',1);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'goal.create',v_id,1,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

CREATE FUNCTION morrow_work.cmd_goal_transition(p_command_id text,p_request_digest text,p_correlation_id text,p_goal_id text,p_to text,p_expected_revision text,p_basis text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; g record; v_at timestamptz; v_result jsonb; v_revision bigint;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_goal_id IS NULL OR p_goal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_to IS NULL OR p_to NOT IN ('draft','active','paused','achieved','cancelled')
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^[1-9][0-9]{0,15}$'
  OR p_basis IS NULL OR p_basis NOT IN ('own','other') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF p_expected_revision::numeric>9007199254740991 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.status,x.revision::bigint AS revision,x.owner_principal_id::text AS owner_principal_id,x.owner_membership_id::text AS owner_membership_id INTO g
  FROM morrow_work.goals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_goal_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF g.revision<>p_expected_revision::bigint THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules r WHERE r.machine='goal' AND r.from_status=g.status AND r.to_status=p_to AND r.actor='owner') THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 -- achieved needs accepted completion evidence (P07/P11); a cancelled goal keeps no
 -- live task, and v1 tasks never become terminal (ADR-0010 item 5).
 IF p_to='achieved' OR (p_to='cancelled' AND EXISTS(SELECT 1 FROM morrow_work.tasks t WHERE t.organization_id=p.organization_id
   AND t.workspace_id=p.workspace_id AND t.goal_id=p_goal_id)) THEN
  RETURN QUERY SELECT 'guard_failed'::text,NULL::text; RETURN;
 END IF;
 IF p_basis='own' AND (g.owner_principal_id<>p.principal_id OR g.owner_membership_id<>p.membership_id) THEN
  RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN;
 END IF;
 v_at:=clock_timestamp(); v_revision:=g.revision+1;
 UPDATE morrow_work.goals x SET status=p_to,revision=v_revision,updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_goal_id;
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'goal.status_changed','goal',p_goal_id,v_revision,NULL,
  jsonb_build_object('from',g.status,'to',p_to),p_correlation_id,v_at);
 v_result:=jsonb_build_object('status',p_to,'revision',v_revision);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'goal.transition',p_goal_id,v_revision,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

CREATE FUNCTION morrow_work.cmd_task_create(p_command_id text,p_request_digest text,p_correlation_id text,p_goal_id text,p_objective text,p_allowed_resources text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; g record; v_resources jsonb; v_id text; v_at timestamptz; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_goal_id IS NULL OR p_goal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_objective IS NULL OR char_length(p_objective) NOT BETWEEN 1 AND 8192
  OR p_allowed_resources IS NULL OR octet_length(p_allowed_resources)>4096 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 BEGIN v_resources:=p_allowed_resources::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 IF jsonb_typeof(v_resources)<>'array' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 -- Nested scope: allowedResources is a subset of the goal scope's resources, [W].
 IF NOT (v_resources='[]'::jsonb OR v_resources=jsonb_build_array(jsonb_build_object('organizationId',p.organization_id,
   'workspaceId',p.workspace_id,'storeId',NULL,'connectionId',NULL,'kind','workspace','id',p.workspace_id))) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT x.status INTO g FROM morrow_work.goals x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_goal_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF g.status NOT IN ('draft','active','paused') THEN RETURN QUERY SELECT 'guard_failed'::text,NULL::text; RETURN; END IF;
 IF (SELECT count(*) FROM morrow_work.tasks t WHERE t.organization_id=p.organization_id AND t.workspace_id=p.workspace_id AND t.goal_id=p_goal_id)>=200 THEN
  RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
 END IF;
 v_id:=gen_random_uuid()::text; v_at:=clock_timestamp();
 INSERT INTO morrow_work.tasks(organization_id,workspace_id,id,revision,goal_id,status,objective,scope,initiator_principal_id,
  initiator_membership_id,owner_principal_id,owner_membership_id,created_at,updated_at)
 VALUES (p.organization_id,p.workspace_id,v_id,1,p_goal_id,'draft',p_objective,
  jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
   'resources',v_resources,'fields','[]'::jsonb),
  p.principal_id,p.membership_id,p.principal_id,p.membership_id,v_at,v_at);
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.created','task',v_id,1,v_id,
  jsonb_build_object('goalId',p_goal_id,'status','draft'),p_correlation_id,v_at);
 v_result:=jsonb_build_object('taskId',v_id,'revision',1);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'task.create',v_id,1,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

CREATE FUNCTION morrow_work.cmd_task_ready(p_command_id text,p_request_digest text,p_correlation_id text,p_task_id text,p_expected_revision text,p_basis text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; v_goal text; g record; k record; v_at timestamptz; v_result jsonb; v_revision bigint;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_task_id IS NULL OR p_task_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^[1-9][0-9]{0,15}$'
  OR p_basis IS NULL OR p_basis NOT IN ('own','other') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF p_expected_revision::numeric>9007199254740991 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.goal_id::text INTO v_goal FROM morrow_work.tasks x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_task_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 SELECT x.status INTO g FROM morrow_work.goals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=v_goal FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 SELECT x.status,x.revision::bigint AS revision,x.owner_principal_id::text AS owner_principal_id,x.owner_membership_id::text AS owner_membership_id INTO k
  FROM morrow_work.tasks x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_task_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF k.revision<>p_expected_revision::bigint THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules r WHERE r.machine='task' AND r.from_status=k.status AND r.to_status='ready' AND r.actor='owner') THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 IF g.status NOT IN ('draft','active','paused') THEN RETURN QUERY SELECT 'guard_failed'::text,NULL::text; RETURN; END IF;
 IF p_basis='own' AND (k.owner_principal_id<>p.principal_id OR k.owner_membership_id<>p.membership_id) THEN
  RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN;
 END IF;
 v_at:=clock_timestamp(); v_revision:=k.revision+1;
 UPDATE morrow_work.tasks x SET status='ready',revision=v_revision,updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_task_id;
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.status_changed','task',p_task_id,v_revision,p_task_id,
  jsonb_build_object('from',k.status,'to','ready'),p_correlation_id,v_at);
 v_result:=jsonb_build_object('status','ready','revision',v_revision);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'task.ready',p_task_id,v_revision,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

CREATE FUNCTION morrow_work.cmd_task_assign(p_command_id text,p_request_digest text,p_correlation_id text,p_task_id text,p_assignee_principal_id text,p_expected_revision text,p_basis text,p_assignee_grants_digest text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; v_goal text; k record; v_target record; v_id text; v_at timestamptz; v_result jsonb; v_revision bigint;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_task_id IS NULL OR p_task_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_assignee_principal_id IS NULL OR p_assignee_principal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^[1-9][0-9]{0,15}$'
  OR p_basis IS NULL OR p_basis NOT IN ('own','other')
  OR p_assignee_grants_digest IS NULL OR p_assignee_grants_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF p_expected_revision::numeric>9007199254740991 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.goal_id::text INTO v_goal FROM morrow_work.tasks x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_task_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 PERFORM 1 FROM morrow_work.goals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=v_goal FOR UPDATE;
 SELECT x.status,x.revision::bigint AS revision,x.owner_principal_id::text AS owner_principal_id,x.owner_membership_id::text AS owner_membership_id INTO k
  FROM morrow_work.tasks x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_task_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF k.revision<>p_expected_revision::bigint THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
 IF k.status NOT IN ('draft','ready') THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 IF p_basis='own' AND (k.owner_principal_id<>p.principal_id OR k.owner_membership_id<>p.membership_id) THEN
  RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN;
 END IF;
 SELECT r.outcome,r.membership_id INTO v_target FROM morrow_work.target_recheck(p.organization_id,p.workspace_id,p_assignee_principal_id,p_assignee_grants_digest) r;
 IF v_target.outcome IS DISTINCT FROM 'current' THEN RETURN QUERY SELECT COALESCE(v_target.outcome,'not_found'),NULL::text; RETURN; END IF;
 v_id:=gen_random_uuid()::text; v_at:=clock_timestamp(); v_revision:=k.revision+1;
 UPDATE morrow_work.tasks x SET owner_principal_id=p_assignee_principal_id,owner_membership_id=v_target.membership_id,revision=v_revision,updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_task_id;
 INSERT INTO morrow_work.task_assignments(organization_id,workspace_id,id,task_id,assignee_principal_id,assignee_membership_id,
  assigned_by_principal_id,assigned_by_membership_id,task_revision,created_at)
 VALUES (p.organization_id,p.workspace_id,v_id,p_task_id,p_assignee_principal_id,v_target.membership_id,p.principal_id,p.membership_id,v_revision,v_at);
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.assigned','task',p_task_id,v_revision,p_task_id,
  jsonb_build_object('assignmentId',v_id,'ownerPrincipalId',p_assignee_principal_id),p_correlation_id,v_at);
 v_result:=jsonb_build_object('assignmentId',v_id,'revision',v_revision);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'task.assign',p_task_id,v_revision,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

CREATE FUNCTION morrow_work.cmd_question_request(p_command_id text,p_request_digest text,p_correlation_id text,p_task_id text,p_prompt text,p_respondent_principal_id text,p_respondent_grants_digest text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; v_target record; v_id text; v_at timestamptz; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_task_id IS NULL OR p_task_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_prompt IS NULL OR char_length(p_prompt) NOT BETWEEN 1 AND 8192
  OR p_respondent_principal_id IS NULL OR p_respondent_principal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_respondent_grants_digest IS NULL OR p_respondent_grants_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 PERFORM 1 FROM morrow_work.tasks x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_task_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF (SELECT count(*) FROM morrow_work.questions q WHERE q.organization_id=p.organization_id AND q.workspace_id=p.workspace_id
   AND q.task_id=p_task_id AND q.status='open')>=50 THEN
  RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
 END IF;
 SELECT r.outcome,r.membership_id INTO v_target FROM morrow_work.target_recheck(p.organization_id,p.workspace_id,p_respondent_principal_id,p_respondent_grants_digest) r;
 IF v_target.outcome IS DISTINCT FROM 'current' THEN RETURN QUERY SELECT COALESCE(v_target.outcome,'not_found'),NULL::text; RETURN; END IF;
 v_id:=gen_random_uuid()::text; v_at:=clock_timestamp();
 INSERT INTO morrow_work.questions(organization_id,workspace_id,id,revision,task_id,status,prompt,requester_principal_id,
  requester_membership_id,respondent_principal_id,respondent_membership_id,created_at,updated_at)
 VALUES (p.organization_id,p.workspace_id,v_id,1,p_task_id,'open',p_prompt,p.principal_id,p.membership_id,p_respondent_principal_id,v_target.membership_id,v_at,v_at);
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'question.requested','question',v_id,1,p_task_id,
  jsonb_build_object('respondentPrincipalId',p_respondent_principal_id),p_correlation_id,v_at);
 v_result:=jsonb_build_object('questionId',v_id,'status','open');
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'question.request',v_id,1,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

CREATE FUNCTION morrow_work.cmd_question_answer(p_command_id text,p_request_digest text,p_correlation_id text,p_question_id text,p_answer_id text,p_body text,p_expected_revision text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; v_task text; q record; v_at timestamptz; v_result jsonb; v_revision bigint; v_digest text;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_question_id IS NULL OR p_question_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_answer_id IS NULL OR p_answer_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_body IS NULL OR char_length(p_body) NOT BETWEEN 1 AND 8192
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^[1-9][0-9]{0,15}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF p_expected_revision::numeric>9007199254740991 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.task_id::text INTO v_task FROM morrow_work.questions x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 PERFORM 1 FROM morrow_work.tasks x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=v_task FOR UPDATE;
 SELECT x.status,x.revision::bigint AS revision,x.respondent_principal_id::text AS respondent_principal_id,
  x.respondent_membership_id::text AS respondent_membership_id INTO q
  FROM morrow_work.questions x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 -- Only the designated respondent answers; administer never answers for another.
 IF q.respondent_principal_id<>p.principal_id OR q.respondent_membership_id<>p.membership_id THEN
  RETURN QUERY SELECT 'not_respondent'::text,NULL::text; RETURN;
 END IF;
 IF q.revision<>p_expected_revision::bigint THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules r WHERE r.machine='question' AND r.from_status=q.status AND r.to_status='answered' AND r.actor='eligible_respondent') THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 v_at:=clock_timestamp(); v_revision:=q.revision+1; v_digest:=encode(sha256(convert_to(p_body,'UTF8')),'hex');
 INSERT INTO morrow_work.question_answers(organization_id,workspace_id,id,question_id,body,body_digest,answered_by_principal_id,answered_by_membership_id,created_at)
 VALUES (p.organization_id,p.workspace_id,p_answer_id,p_question_id,p_body,v_digest,p.principal_id,p.membership_id,v_at);
 UPDATE morrow_work.questions x SET status='answered',revision=v_revision,updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id;
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'question.answered','question',p_question_id,v_revision,v_task,
  jsonb_build_object('answerId',p_answer_id),p_correlation_id,v_at);
 v_result:=jsonb_build_object('answerRevision',v_revision,'answerRef',jsonb_build_object('organizationId',p.organization_id,
  'workspaceId',p.workspace_id,'storeId',NULL,'kind','answer','id',p_answer_id,'revision',1,'digest',v_digest));
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'question.answer',p_question_id,v_revision,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

CREATE FUNCTION morrow_work.cmd_question_cancel(p_command_id text,p_request_digest text,p_correlation_id text,p_question_id text,p_expected_revision text,p_basis text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; v_task text; q record; v_at timestamptz; v_result jsonb; v_revision bigint;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_question_id IS NULL OR p_question_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^[1-9][0-9]{0,15}$'
  OR p_basis IS NULL OR p_basis NOT IN ('own','other') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF p_expected_revision::numeric>9007199254740991 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.task_id::text INTO v_task FROM morrow_work.questions x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 PERFORM 1 FROM morrow_work.tasks x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=v_task FOR UPDATE;
 SELECT x.status,x.revision::bigint AS revision,x.requester_principal_id::text AS requester_principal_id,
  x.requester_membership_id::text AS requester_membership_id INTO q
  FROM morrow_work.questions x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF q.revision<>p_expected_revision::bigint THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules r WHERE r.machine='question' AND r.from_status=q.status AND r.to_status='cancelled' AND r.actor='owner') THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 IF p_basis='own' AND (q.requester_principal_id<>p.principal_id OR q.requester_membership_id<>p.membership_id) THEN
  RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN;
 END IF;
 v_at:=clock_timestamp(); v_revision:=q.revision+1;
 UPDATE morrow_work.questions x SET status='cancelled',revision=v_revision,updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id;
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'question.cancelled','question',p_question_id,v_revision,v_task,
  '{}'::jsonb,p_correlation_id,v_at);
 v_result:=jsonb_build_object('status','cancelled','revision',v_revision);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'question.cancel',p_question_id,v_revision,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- Explicit ACLs per function (S5 reads proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.command_prelude(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.target_recheck(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.append_event(text,text,text,text,text,text,text,bigint,text,jsonb,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.enter_context(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.begin_command(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.target_member(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_goal_create(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_goal_transition(text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_task_create(text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_task_ready(text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_task_assign(text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_question_request(text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_question_answer(text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_question_cancel(text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.enter_context(text,text),morrow_work.begin_command(text,text,text),
 morrow_work.target_member(text),morrow_work.cmd_goal_create(text,text,text,text,text),
 morrow_work.cmd_goal_transition(text,text,text,text,text,text,text),morrow_work.cmd_task_create(text,text,text,text,text,text),
 morrow_work.cmd_task_ready(text,text,text,text,text,text),morrow_work.cmd_task_assign(text,text,text,text,text,text,text,text),
 morrow_work.cmd_question_request(text,text,text,text,text,text,text),morrow_work.cmd_question_answer(text,text,text,text,text,text,text),
 morrow_work.cmd_question_cancel(text,text,text,text,text,text) TO morrow_work_api;
GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.current_tenant() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.command_prelude(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.target_recheck(text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.append_event(text,text,text,text,text,text,text,bigint,text,jsonb,text,timestamptz) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamptz) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.enter_context(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.begin_command(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.target_member(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_goal_create(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_goal_transition(text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_task_create(text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_task_ready(text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_task_assign(text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_question_request(text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_question_answer(text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_question_cancel(text,text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;
COMMIT;
