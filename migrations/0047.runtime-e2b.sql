BEGIN;
-- Build order PR 8, Connect E2B (ADR-0029 items 2, 3 and 9, as amended by ADR-0035 item 6;
-- docs/briefs/e2b-adapter.md). Executes AS morrow_work_owner, after 0046 (the next free number
-- on main when written; the merge train renumbers it if another PR lands first). No external
-- effect: nothing here creates, reads or kills a sandbox, and the runtime switch stays off.
--   * The sandbox's envd token as a vault record (ADR-0029 item 3: "Each sandbox's envd token
--     is a broker vault record destroyed at kill"). morrow_vault.credentials admits the provider
--     `e2b` with the kind `e2b_envd_token` (only together), keyed by its runtime operation (id and
--     subject are the operation id, version 1 only), and three destroy reasons that only this
--     kind uses: sandbox_killed, sandbox_absent, sandbox_unknown. The vault keeps its two
--     sealed-secret tables (lab:spine-foundation V3); no table is added.
--   * runtime_token_put and runtime_token_get: the broker's login stores the sealed token once,
--     while the operation is `created`, and opens it for each call to the sandbox while the
--     operation is still `created`. No definer returns a token in the clear; the envelope's
--     additional data binds the operation id (apps/broker/src/vault.ts).
--   * morrow_work.runtime_token_end, a trigger on the operations: every settlement, terminal or
--     unknown_effect, destroys the operation's active envd token in the same statement, by
--     whichever definer settles it (0043's runtime_operation_settle is unchanged). So no token
--     outlives its sandbox's last known state, and a stop's sweep that kills a sandbox also
--     cuts off a job still running there at its next call.
--   * runtime_operations_sweep, beside 0043's runtime_operations_open (which the broker's
--     statement registry no longer sends): the same ids-only list plus `stopped`, the open
--     operations a stop (platform, connection or installation: morrow_work.stop_active), an
--     ended lease or an expired one has cut off, stale or not, so stops kill their scope's
--     sandboxes at once (ADR-0029 item 9). Each row's lease and stops are read through
--     resolve_call's own broker policies (0031), with the settings written before the read and
--     cleared after; never a tenant key, a run or content.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regclass('morrow_work.runtime_operations') IS NULL OR to_regclass('morrow_vault.credentials') IS NULL
 OR to_regprocedure('morrow_work.stop_active(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_vault.runtime_operation_settle(text,text,text)') IS NULL
 OR to_regprocedure('morrow_vault.runtime_token_put(text,text,text,text)') IS NOT NULL
 OR to_regprocedure('morrow_vault.runtime_token_get(text)') IS NOT NULL
 OR to_regprocedure('morrow_vault.runtime_operations_sweep(text)') IS NOT NULL
 OR to_regprocedure('morrow_work.runtime_token_end()') IS NOT NULL
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_vault.credentials'::regclass
   AND c.conname='credentials_provider_check') IS DISTINCT FROM 'CHECK ((provider = ''shopify''::text))'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_vault.credentials'::regclass
   AND c.conname='credentials_kind_check') IS DISTINCT FROM 'CHECK ((kind = ''shopify_offline_token''::text))'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_vault.credentials'::regclass
   AND c.conname='credentials_destroy_reason_check')
  IS DISTINCT FROM 'CHECK ((destroy_reason = ANY (ARRAY[''uninstalled''::text, ''disconnected''::text, ''reauthorised''::text, ''scopes_changed''::text])))'
 OR NOT pg_catalog.has_table_privilege('morrow_work_command','morrow_vault.credentials','INSERT')
 OR NOT pg_catalog.has_column_privilege('morrow_work_command','morrow_vault.credentials','destroy_reason','UPDATE')
 THEN RAISE EXCEPTION 'RUNTIME_E2B_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The envd token's place in the vault. A Shopify row is unchanged; an E2B row is the one kind
-- `e2b_envd_token`, and only its three reasons end it.
ALTER TABLE morrow_vault.credentials DROP CONSTRAINT credentials_provider_check,
 ADD CONSTRAINT credentials_provider_check CHECK (provider IN ('shopify','e2b')),
 DROP CONSTRAINT credentials_kind_check,
 ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('shopify_offline_token','e2b_envd_token')),
 ADD CONSTRAINT credentials_provider_kind CHECK ((provider='e2b')=(kind='e2b_envd_token')),
 DROP CONSTRAINT credentials_destroy_reason_check,
 ADD CONSTRAINT credentials_destroy_reason_check CHECK (destroy_reason IN ('uninstalled','disconnected','reauthorised','scopes_changed',
  'sandbox_killed','sandbox_absent','sandbox_unknown')),
 ADD CONSTRAINT credentials_envd_token CHECK (kind<>'e2b_envd_token' OR (version=1 AND id=subject_id
  AND id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  AND (destroy_reason IS NULL OR destroy_reason IN ('sandbox_killed','sandbox_absent','sandbox_unknown')))),
 ADD CONSTRAINT credentials_shopify_reason CHECK (kind<>'shopify_offline_token' OR destroy_reason IS NULL
  OR destroy_reason IN ('uninstalled','disconnected','reauthorised','scopes_changed'));

-- ---------------------------------------------------------------------------
-- The token's end: any settlement of its operation destroys it (vault_guard's one update: the
-- key material erased, the row kept as metadata). INVOKER, owned by the owner, granted to
-- nobody; it runs as the role that settles (the command role inside the broker's definers,
-- where the vault_broker policy admits the broker's session), in the settlement's own
-- statement. sandbox_killed for killed, sandbox_absent for absent_verified, sandbox_unknown
-- for an unknown effect (not_created never had one).
CREATE FUNCTION morrow_work.runtime_token_end() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 UPDATE morrow_vault.credentials c SET status='destroyed',wrapped_key=NULL,sealed_value=NULL,
  destroyed_at=greatest(date_trunc('milliseconds',clock_timestamp()),c.created_at),
  destroy_reason=CASE NEW.status WHEN 'killed' THEN 'sandbox_killed' WHEN 'absent_verified' THEN 'sandbox_absent' ELSE 'sandbox_unknown' END
  WHERE c.organization_id=NEW.organization_id AND c.workspace_id=NEW.workspace_id AND c.id=NEW.id
   AND c.provider='e2b' AND c.kind='e2b_envd_token' AND c.status='active';
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION morrow_work.runtime_token_end() FROM PUBLIC;
CREATE TRIGGER runtime_token_end AFTER UPDATE OF status ON morrow_work.runtime_operations FOR EACH ROW
 WHEN (NEW.status IN ('unknown_effect','killed','absent_verified','not_created')) EXECUTE FUNCTION morrow_work.runtime_token_end();

-- ---------------------------------------------------------------------------
-- The broker's definers: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_vault_broker only, each guarded by work_executor_safe. Envelopes travel as hex.

-- Stores the sealed envd token of a `created` operation, once: one token per operation, ever
-- (a destroyed one is never replaced). The tenant is the operation's. Outcomes: stored,
-- refused (the operation is not `created`, or it already has a token), not_found, invalid,
-- denied.
CREATE FUNCTION morrow_vault.runtime_token_put(p_operation_id text,p_kek_version text,p_wrapped_key text,p_sealed_value text)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; v_now timestamptz;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN QUERY SELECT 'denied'::text; RETURN; END IF;
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_kek_version IS NULL OR p_kek_version !~ '^[1-9][0-9]{0,2}$'
  OR p_wrapped_key IS NULL OR p_wrapped_key !~ '^[0-9a-f]{120}$'
  OR p_sealed_value IS NULL OR p_sealed_value !~ '^([0-9a-f]{2}){29,4124}$' THEN
  RETURN QUERY SELECT 'invalid'::text; RETURN;
 END IF;
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.status INTO o
  FROM morrow_work.runtime_operations x WHERE x.id=p_operation_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text; RETURN; END IF;
 IF o.status<>'created' OR EXISTS(SELECT 1 FROM morrow_vault.credentials c WHERE c.organization_id=o.organization_id
   AND c.workspace_id=o.workspace_id AND c.id=p_operation_id) THEN
  RETURN QUERY SELECT 'refused'::text; RETURN;
 END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,
  wrapped_key,sealed_value,created_at,destroyed_at,destroy_reason)
 VALUES (o.organization_id,o.workspace_id,p_operation_id,1,'e2b','e2b_envd_token',p_operation_id,'active',p_kek_version::integer,
  decode(p_wrapped_key,'hex'),decode(p_sealed_value,'hex'),v_now,NULL,NULL);
 RETURN QUERY SELECT 'stored'::text;
END $$;

-- The sealed envd token of an operation still `created`, for one call to its sandbox.
-- Outcomes: active (with the envelope), unavailable (settled, unknown, never stored or
-- destroyed), not_found, invalid, denied.
CREATE FUNCTION morrow_vault.runtime_token_get(p_operation_id text)
RETURNS TABLE(outcome text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; c record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.status INTO o
  FROM morrow_work.runtime_operations x WHERE x.id=p_operation_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.kek_version::text AS kek_version,encode(x.wrapped_key,'hex') AS wrapped_key,encode(x.sealed_value,'hex') AS sealed_value INTO c
  FROM morrow_vault.credentials x WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.id=p_operation_id
   AND x.version=1 AND x.provider='e2b' AND x.kind='e2b_envd_token' AND x.status='active';
 IF NOT FOUND OR o.status<>'created' THEN
  RETURN QUERY SELECT 'unavailable'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'active'::text,c.kek_version,c.wrapped_key,c.sealed_value;
END $$;

-- The sweep's list (0043's runtime_operations_open, with stops): open operations, least
-- recently reconciled first, across tenants, ids only, that are stale (past the longest
-- execute) or stopped (a stop covers the run, or its lease is no longer active or has expired).
-- `stale`, `past_grace` and `stopped` say which. Each row's lease and stops are read through
-- resolve_call's broker policies (0031: the lease by morrow.vault_resolve_lease, the tenant's
-- stops by morrow.vault_resolve_tenant, the platform's always), written before the read and
-- cleared after. Outcomes are rows (none when denied).
CREATE FUNCTION morrow_vault.runtime_operations_sweep(p_limit text)
RETURNS TABLE(operation_id text,provider text,sandbox_ref text,status text,deadline_at text,stale boolean,past_grace boolean,stopped boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE k record; x record; l record; v_now timestamptz; v_stale boolean; v_stopped boolean; v_found boolean; v_count integer:=0;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') OR p_limit IS NULL OR p_limit !~ '^[1-9][0-9]?$' THEN RETURN; END IF;
 SELECT * INTO k FROM morrow_work.runtime_caps();
 v_now:=pg_catalog.clock_timestamp();
 FOR x IN SELECT r.organization_id::text AS organization_id,r.workspace_id::text AS workspace_id,r.id::text AS id,r.provider,r.sandbox_ref,
   r.status,r.deadline_at,r.send_started_at,r.lease_id::text AS lease_id,r.installation_id::text AS installation_id
  FROM morrow_work.runtime_operations r WHERE r.status IN ('sending','created','unknown_effect')
  ORDER BY COALESCE(r.reconciled_at,r.send_started_at),r.id LOOP
  v_stale:=x.send_started_at+make_interval(secs=>k.stale_seconds)<=v_now;
  PERFORM pg_catalog.set_config('morrow.vault_resolve_lease',x.lease_id,true),
   pg_catalog.set_config('morrow.vault_resolve_tenant',x.organization_id||'|'||x.workspace_id,true);
  SELECT w.status,w.expires_at,w.connection_id::text AS connection_id INTO l FROM morrow_work.work_leases w WHERE w.id=x.lease_id;
  v_found:=FOUND;
  v_stopped:=NOT v_found OR l.status<>'active' OR l.expires_at<=v_now
   OR morrow_work.stop_active(x.organization_id,x.workspace_id,'run',l.connection_id,x.installation_id);
  PERFORM pg_catalog.set_config('morrow.vault_resolve_lease','',true),pg_catalog.set_config('morrow.vault_resolve_tenant','',true);
  CONTINUE WHEN NOT (v_stale OR v_stopped);
  operation_id:=x.id; provider:=x.provider; sandbox_ref:=x.sandbox_ref; status:=x.status;
  deadline_at:=to_char(x.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  stale:=v_stale; past_grace:=v_now>=x.deadline_at+make_interval(secs=>k.absent_grace_seconds); stopped:=v_stopped;
  RETURN NEXT;
  v_count:=v_count+1;
  EXIT WHEN v_count>=p_limit::integer;
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S7 reads proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_vault.runtime_token_put(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_vault.runtime_token_get(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_vault.runtime_operations_sweep(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_vault.runtime_token_put(text,text,text,text),morrow_vault.runtime_token_get(text),
 morrow_vault.runtime_operations_sweep(text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_vault.runtime_token_put(text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.runtime_token_get(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.runtime_operations_sweep(text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_vault FROM morrow_work_command;
COMMIT;
