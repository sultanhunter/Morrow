BEGIN;
-- BRANCH-LOCAL STUB, never merged (integration interface "Billing facts, billing period and
-- credit wallet"): M3 PR-1's reservation helpers move credits in M5 PR-1's
-- morrow_billing.credit_wallets before M5 PR-1 merges. At the final rebase this file and
-- its manifest row are deleted and M5's own table (with its foreign key to
-- billing_accounts, its grant-funded increases and its policies) takes its place.
-- Executes AS morrow_work_owner. The shape is the interface's: PRIMARY KEY (organization_id,
-- workspace_id, billing_account_id); available, reserved and consumed bigint >= 0;
-- rate_revision, terms_revision, revision and updated_at; UPDATE(available, reserved,
-- consumed, revision, updated_at) for morrow_work_command; an owner-owned INVOKER
-- wallet_guard that requires revision+1 and admits only moves that keep
-- available+reserved+consumed constant (a grant-funded increase is M5's; laboratories fund
-- a wallet as the owner).
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR to_regnamespace('morrow_billing') IS NULL
 OR to_regclass('morrow_billing.credit_wallets') IS NOT NULL
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR NOT morrow_identity.morrow_memberships_closed()
 THEN RAISE EXCEPTION 'CREDIT_WALLETS_STUB_PREREQUISITES_INVALID'; END IF;
END $$;

CREATE TABLE morrow_billing.credit_wallets (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 billing_account_id morrow_work.record_id NOT NULL,
 available bigint NOT NULL CHECK (available>=0),
 reserved bigint NOT NULL CHECK (reserved>=0),
 consumed bigint NOT NULL CHECK (consumed>=0),
 rate_revision morrow_work.revision NOT NULL,
 terms_revision morrow_work.revision NOT NULL,
 revision morrow_work.revision NOT NULL,
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,billing_account_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id)
);
ALTER TABLE morrow_billing.credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_billing.credit_wallets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON morrow_billing.credit_wallets FROM PUBLIC;
CREATE POLICY work_owner ON morrow_billing.credit_wallets TO morrow_work_owner USING (true) WITH CHECK (true);
CREATE POLICY tenant_command ON morrow_billing.credit_wallets TO morrow_work_command
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
 WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
CREATE POLICY tenant_read ON morrow_billing.credit_wallets FOR SELECT TO morrow_work_api
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
GRANT SELECT,INSERT ON morrow_billing.credit_wallets TO morrow_work_command;
GRANT UPDATE (available,reserved,consumed,revision,updated_at) ON morrow_billing.credit_wallets TO morrow_work_command;
GRANT SELECT (organization_id,workspace_id,billing_account_id,available,reserved,consumed,rate_revision,terms_revision,revision,updated_at)
 ON morrow_billing.credit_wallets TO morrow_work_api;

-- INVOKER, owned by the owner (replaceable by M5), granted to nobody.
CREATE FUNCTION morrow_billing.wallet_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['available','reserved','consumed','revision','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.reserved<>0 OR NEW.consumed<>0 THEN RAISE EXCEPTION 'CREDIT_WALLET_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.available+NEW.reserved+NEW.consumed<>OLD.available+OLD.reserved+OLD.consumed THEN
  RAISE EXCEPTION 'CREDIT_WALLET_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_billing.wallet_guard() FROM PUBLIC;
CREATE TRIGGER wallet_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_billing.credit_wallets FOR EACH ROW EXECUTE FUNCTION morrow_billing.wallet_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_billing.credit_wallets FOR EACH STATEMENT EXECUTE FUNCTION morrow_billing.wallet_guard();
COMMIT;
