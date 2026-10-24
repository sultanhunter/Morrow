BEGIN;
-- "Disconnect store", the work side (ADR-0022 items 2, 3, 13 and 15 with the amendments of
-- 2026-10-22, owner decision 8; ADR-0005; ADR-0031 item 3; mvp-architecture §10). Executes
-- AS morrow_work_owner, after the disconnect-store identity migration. It adds:
--   * kill_switch_records names a connection: capability governance.connection.disconnect
--     with target kind connection (its target id is its connection id), beside "Stop AI
--     work"'s installation target, and the owner-owned kill_switch_record_matches revised
--     for that KillSwitchRecord (core v1.1 KillSwitchConnectionTarget);
--   * the commands CHECKs widened by connection.disconnect (each the union of every value at
--     this head);
--   * the api's definers (SECURITY DEFINER, owned by the command role, EXECUTE for
--     morrow_work_api only; tenant and actor only from current_tenant()):
--     begin_connection_command (replay first), connection_target (the session tenant's
--     store installation of one connection, linked at some time; ids and status only) and
--     cmd_store_disconnect: after the Worker's kernel allowed
--     governance.connection.disconnect {execute} on the store resource (store-link
--     template v2) and checkKillSwitchTarget planned it, in one transaction it ends the
--     installation (suspended, `disconnected`, through 0036's
--     work_shopify_installation_end, which also revokes open handoffs and continuations),
--     then, under the store's stop interlock, commits the KillSwitchRecord and, unless a
--     connection stop already stands, the human connection stop that names it; stop_guard
--     revokes every lease on the connection in the same statement (read, run and
--     operation), so no read, run step, model call, claim or dispatch on that store passes
--     its stop check afterwards (lease_open, resolve_call, the run steps; the gateway's
--     claim and dispatch when they land).
-- The offline token is destroyed after COMMIT by the broker (ApiBroker
-- shopifyCredentialDestroy, the vault definer of 0037 with reason `disconnected`); the
-- connector's cron re-drives any destruction that did not complete. A disconnect deletes no
-- store content and starts no deletion clock (ADR-0031 item 3): shop/redact, or the
-- uninstall's own path, still does. Only a person lifts a stop; nothing here lifts one.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regclass('morrow_work.kill_switch_records') IS NULL OR to_regclass('morrow_work.stop_controls') IS NULL
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.append_event(text,text,text,text,text,text,text,bigint,text,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.db_now()') IS NULL OR to_regprocedure('morrow_work.utc_parse(text)') IS NULL
 OR to_regprocedure('morrow_work.sha256_text(text)') IS NULL OR to_regprocedure('morrow_work.json_id(jsonb)') IS NULL
 OR to_regprocedure('morrow_work.begin_connection_command(text,text,text)') IS NOT NULL
 OR to_regprocedure('morrow_work.connection_target(text)') IS NOT NULL
 OR to_regprocedure('morrow_work.cmd_store_disconnect(text,text,text,text,text,text)') IS NOT NULL
 -- Template v2 is in place (the identity migration ran first), and the two identity
 -- bridges this file's definer calls are the command role's.
 OR to_regprocedure('morrow_identity.store_link_grants_v2()') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_store_installations(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_installation_end(text,text,text,text)','EXECUTE')
 -- The owner-owned check this file replaces, exactly as 0031 wrote it, and the CHECKs it
 -- widens, exactly as the head defines them (shared protocol).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure(
   'morrow_work.kill_switch_record_matches(text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamp with time zone)'))
  IS DISTINCT FROM 'ac454183937d54aa0e3a79bf986d41dc'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.kill_switch_records'::regclass
   AND c.conname='kill_switch_records_capability_id_check') IS DISTINCT FROM 'CHECK ((capability_id = ''agents.installation.disable''::text))'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.kill_switch_records'::regclass
   AND c.conname='kill_switch_records_target_kind_check') IS DISTINCT FROM 'CHECK ((target_kind = ''installation''::text))'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_command_type_check')
  IS DISTINCT FROM 'ca4b097af5cd5ddf3e97bf48b214bc56'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_check')
  IS DISTINCT FROM 'a517388dfd7a53b7eac1151d9cbccab6'
 THEN RAISE EXCEPTION 'DISCONNECT_STORE_WORK_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- KillSwitchRecord of "Disconnect store" (core v1.1, the item 2 amendment): exactly the row,
-- as for "Stop AI work", with one more pair: governance.connection.disconnect on target kind
-- connection, whose target is the connection itself ({kind: connection, id: connectionId,
-- storeId, connectionId}). The human actor, a control whose reason is the stop's reason and
-- a null sourceProposalRef (no agent proposal path in the MVP) are unchanged. Owned by the
-- owner, IMMUTABLE, EXECUTE for the command role (CREATE OR REPLACE keeps both).
CREATE OR REPLACE FUNCTION morrow_work.kill_switch_record_matches(p_canonical text,p_org text,p_ws text,p_id text,p_store text,p_connection text,
 p_capability text,p_target_kind text,p_target text,p_actor_principal text,p_actor_membership text,p_command_id text,p_request_digest text,
 p_prior text,p_created_at timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE d jsonb;
BEGIN
 IF p_canonical IS NULL OR NOT pg_input_is_valid(p_canonical,'jsonb')
  OR NOT ((p_capability IS NOT DISTINCT FROM 'agents.installation.disable' AND p_target_kind IS NOT DISTINCT FROM 'installation')
   OR (p_capability IS NOT DISTINCT FROM 'governance.connection.disconnect' AND p_target_kind IS NOT DISTINCT FROM 'connection'
    AND p_target IS NOT NULL AND p_target IS NOT DISTINCT FROM p_connection)) THEN RETURN false; END IF;
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

-- The two kill switches the MVP records, each with its own target kind; a disconnect's
-- target is its connection. Existing rows (Stop AI work) satisfy every new CHECK.
ALTER TABLE morrow_work.kill_switch_records DROP CONSTRAINT kill_switch_records_capability_id_check,
 DROP CONSTRAINT kill_switch_records_target_kind_check,
 ADD CONSTRAINT kill_switch_records_capability_id_check CHECK (capability_id IN ('agents.installation.disable','governance.connection.disconnect')),
 ADD CONSTRAINT kill_switch_records_target_kind_check CHECK (target_kind IN ('installation','connection')),
 ADD CONSTRAINT kill_switch_records_target_pair CHECK ((capability_id='agents.installation.disable' AND target_kind='installation')
  OR (capability_id='governance.connection.disconnect' AND target_kind='connection' AND target_id::text=connection_id::text));
ALTER TABLE morrow_work.commands DROP CONSTRAINT commands_command_type_check, DROP CONSTRAINT commands_check,
 ADD CONSTRAINT commands_command_type_check CHECK (command_type IN ('goal.create','goal.transition','task.create','task.ready','task.assign',
  'question.request','question.answer','question.cancel','proposal.submit','approval.decide','approval.withdraw',
  'installation.document','installation.enable','installation.stop','model_default.revise','run.admit','run.reconcile',
  'connection.disconnect')),
 ADD CONSTRAINT commands_check CHECK (aggregate_type IN ('goal','task','question','proposal','approval','installation','model_default','run',
  'connection') AND aggregate_type=split_part(command_type,'.',1));

-- ---------------------------------------------------------------------------
-- API functions: SECURITY DEFINER, owned by the command role after the transfer below,
-- EXECUTE for morrow_work_api only. Tenant and actor come only from current_tenant().
-- Replay first for the connection commands (begin_agent_command's shape): the per-actor key
-- lock, then the recorded command.
CREATE FUNCTION morrow_work.begin_connection_command(p_type text,p_command_id text,p_request_digest text)
RETURNS TABLE(outcome text,aggregate_type text,aggregate_id text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; c record;
BEGIN
 IF p_type IS NULL OR p_type<>'connection.disconnect'
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
-- The session tenant's store installation of one connection, if it was ever linked into
-- this workspace (linked now, or suspended or uninstalled after a link), with the database
-- clock. Ids and status only; read before any command takes its locks, so never trusted as
-- current: cmd_store_disconnect re-reads it under lock. Nothing for another tenant's
-- connection, an unlinked installation or an unknown id.
CREATE FUNCTION morrow_work.connection_target(p_connection_id text)
RETURNS TABLE(connection_id text,store_id text,installation_id text,status text,database_now text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 IF p_connection_id IS NULL OR p_connection_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT i.connection_id,i.store_id,i.installation_id,i.status,morrow_work.utc_text(morrow_work.db_now())
  FROM morrow_identity.work_store_installations(t.organization_id,t.workspace_id) i
  WHERE i.connection_id=p_connection_id AND i.linked_at IS NOT NULL LIMIT 1;
END $$;

-- "Disconnect store" (governance.connection.disconnect, a human-only kill switch: no
-- approval, a recorded reason, an append-only KillSwitchRecord; ADR-0005), after the
-- Worker's kernel allowed `execute` on the store resource with the connectionId and control
-- fields and checkKillSwitchTarget planned the connection stop. In one transaction:
--   1. the prelude (key lock, the command row, the locked authority recheck, the stream
--      lock), then the connection's installation, re-read for this tenant;
--   2. the installation ends first, in the connector applier's lock order (the per-shop
--      install lock, then the store's stop interlock), so a concurrent uninstall never
--      deadlocks with a disconnect: a linked installation becomes suspended
--      (`disconnected`); an ended one stays as it is;
--   3. the store's stop interlock, exclusive (stop_guard's key), then the prior state: an
--      open connection stop of any setter is already_stopped. The record must have observed
--      the same, or nothing is written (state_conflict: reread, then retry with a new
--      record);
--   4. the KillSwitchRecord, and, when the connection was active, the human connection
--      stop that names it (stop_guard revokes every lease on the connection);
--   5. the kill_switch.executed event and the recorded result (the end reason, so the
--      Worker asks the broker to destroy the token only for a disconnected installation).
-- It never reads entitlement or credits (ADR-0011 Q8) and lifts nothing. Outcomes: applied,
-- invalid, ineligible, stale_authority, command_conflict, not_found, state_conflict.
CREATE FUNCTION morrow_work.cmd_store_disconnect(p_command_id text,p_request_digest text,p_correlation_id text,p_connection_id text,
 p_record_canonical text,p_record_digest text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; i record; e record; d jsonb; v_created timestamptz; v_now timestamptz; v_prior text; v_stop text; v_result jsonb;
 v_conflict boolean:=false;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_connection_id IS NULL OR p_connection_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
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
 SELECT x.installation_id,x.store_id,x.status INTO i FROM morrow_identity.work_store_installations(p.organization_id,p.workspace_id) x
  WHERE x.connection_id=p_connection_id AND x.linked_at IS NOT NULL LIMIT 1;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 -- Every write below is one block: a refusal after the installation's end rolls it back.
 BEGIN
  SELECT * INTO e FROM morrow_identity.work_shopify_installation_end(p.organization_id,p.workspace_id,i.installation_id,'disconnected');
  IF e.outcome IS NULL OR e.outcome NOT IN ('applied','unchanged') OR e.connection_id IS DISTINCT FROM p_connection_id
   OR e.store_id IS DISTINCT FROM i.store_id THEN
   RAISE EXCEPTION 'DISCONNECT_INSTALLATION_END_REFUSED';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
   p.organization_id,p.workspace_id,i.store_id)::text,0));
  SELECT x.id::text INTO v_stop FROM morrow_work.stop_controls x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.scope='connection' AND x.target_id=p_connection_id AND x.lifted_at IS NULL;
  v_prior:=CASE WHEN FOUND THEN 'already_stopped' ELSE 'active' END;
  IF d->'priorStateObserved' IS DISTINCT FROM to_jsonb(v_prior) THEN
   v_conflict:=true;
   RAISE EXCEPTION 'DISCONNECT_STATE_CONFLICT';
  END IF;
  INSERT INTO morrow_work.kill_switch_records(organization_id,workspace_id,id,store_id,connection_id,capability_id,target_kind,target_id,
   actor_principal_id,actor_membership_id,canonical,digest,command_id,request_digest,prior_state_observed,created_at)
  VALUES (p.organization_id,p.workspace_id,d->>'id',i.store_id,p_connection_id,'governance.connection.disconnect','connection',p_connection_id,
   p.principal_id,p.membership_id,p_record_canonical,p_record_digest,p_command_id,p_request_digest,v_prior,v_created);
  IF v_prior='active' THEN
   v_stop:=gen_random_uuid()::text;
   INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,
    set_by_membership_id,set_by_operator_id,reason_code,reason,created_at,kill_switch_record_id)
   VALUES (p.organization_id,p.workspace_id,v_stop,'connection',i.store_id,p_connection_id,'human',p.principal_id,p.membership_id,NULL,
    'human_disconnect',d#>>'{control,reason}',v_now,d->>'id');
  END IF;
 EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT CASE WHEN v_conflict THEN 'state_conflict' ELSE 'invalid' END,NULL::text; RETURN;
 END;
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'kill_switch.executed','kill_switch',d->>'id',1,
  NULL,jsonb_build_object('capabilityId','governance.connection.disconnect','sourceProposalId',NULL),p_correlation_id,v_now);
 v_result:=jsonb_build_object('status','disconnected','killSwitchRecordId',d->>'id','priorStateObserved',v_prior,'stopId',v_stop,
  'connectionId',p_connection_id,'storeId',i.store_id,'installationId',i.installation_id,'installation',e.status,'endReason',e.end_reason);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'connection.disconnect',p_connection_id,1,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.begin_connection_command(text,text,text),morrow_work.connection_target(text),
 morrow_work.cmd_store_disconnect(text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.begin_connection_command(text,text,text),morrow_work.connection_target(text),
 morrow_work.cmd_store_disconnect(text,text,text,text,text,text) TO morrow_work_api;
GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.begin_connection_command(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connection_target(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_store_disconnect(text,text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;
COMMIT;
