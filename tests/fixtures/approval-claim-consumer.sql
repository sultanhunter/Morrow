-- P06.T01b-AC12 laboratory-only claim consumer. Never part of a migration. It
-- proves the consumer contract of §5 Claim that P05.T01z and P05.T02a build on:
-- a work-owned api-executable definer that (1) runs command_prelude_exclusive,
-- which takes the organization interlock and row FOR UPDATE before the stream,
-- (2) calls morrow_work.approval_claim, (3) derives its effect input only from the
-- stored proposal and parameters it returns (a derived proposal applies only its
-- own targets), and (4) applies the effect through an identity definer granted to
-- morrow_work_command (the P06.T01a bridge direction). Any non-applied outcome,
-- or an effect error, rolls back the whole transaction: no claim, no effect.
-- The lab runs part 1 as morrow_identity_owner and part 2 as morrow_work_owner.

-- PART 1 (morrow_identity_owner)
BEGIN;
CREATE TABLE morrow_identity.lab_effects (
 id text PRIMARY KEY,
 organization_id text NOT NULL,
 workspace_id text NOT NULL,
 capability_id text NOT NULL,
 detail text NOT NULL,
 consumer_command_id text NOT NULL UNIQUE,
 applied_at timestamptz NOT NULL
);
ALTER TABLE morrow_identity.lab_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_identity.lab_effects FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_owner ON morrow_identity.lab_effects TO morrow_identity_owner USING (true) WITH CHECK (true);
-- The identity effect. A grant revision needs its beneficiary to be an active
-- human member of the workspace; p_fail forces an effect error after the claim.
CREATE FUNCTION morrow_identity.lab_apply_effect(p_org text,p_ws text,p_capability text,p_detail text,p_command text,p_fail boolean)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE v_id text;
BEGIN
 IF p_fail THEN RAISE EXCEPTION 'LAB_EFFECT_FAILED'; END IF;
 IF p_capability='governance.grants.revise' AND NOT EXISTS(SELECT 1 FROM morrow_identity.memberships m
   JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=m.organization_id AND wm.membership_id=m.id AND wm.workspace_id=p_ws AND wm.active
   WHERE m.organization_id=p_org AND m.principal_id=p_detail AND m.active) THEN RAISE EXCEPTION 'LAB_EFFECT_TARGET'; END IF;
 v_id:=gen_random_uuid()::text;
 INSERT INTO morrow_identity.lab_effects VALUES (v_id,p_org,p_ws,p_capability,p_detail,p_command,clock_timestamp());
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.lab_apply_effect(text,text,text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.lab_apply_effect(text,text,text,text,text,boolean) TO morrow_work_command;
COMMIT;

-- PART 2 (morrow_work_owner)
BEGIN;
CREATE FUNCTION morrow_work.lab_claim_consumer(p_command_id text,p_request_digest text,p_approval_id text,p_approval_revision text,
 p_approval_digest text,p_proposal_id text,p_proposal_digest text,p_counted text,p_fail text)
RETURNS TABLE(outcome text,effect_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; c record; v_detail text; v_effect text;
BEGIN
 SELECT * INTO p FROM morrow_work.command_prelude_exclusive(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT * INTO c FROM morrow_work.approval_claim(p_approval_id,p_approval_revision,p_approval_digest,p_proposal_id,p_proposal_digest,
  'lab.consumer',p_command_id,p_counted);
 IF c.outcome<>'applied' THEN RETURN QUERY SELECT c.outcome,NULL::text; RETURN; END IF;
 -- The effect input comes only from the stored documents the claim returned.
 IF c.proposal->>'capabilityId'='governance.grants.revise' AND jsonb_typeof(c.parameters->'beneficiaryPrincipalId')='string' THEN
  v_detail:=c.parameters->>'beneficiaryPrincipalId';
 ELSIF c.proposal->>'capabilityId'='governance.privacy.erase' THEN
  SELECT jsonb_agg(t->'expectedSourceRevision' ORDER BY o)::text INTO v_detail FROM jsonb_array_elements(c.proposal->'targets') WITH ORDINALITY x(t,o);
 ELSE
  RAISE EXCEPTION 'LAB_CONSUMER_INPUT';
 END IF;
 v_effect:=morrow_identity.lab_apply_effect(p.organization_id,p.workspace_id,c.proposal->>'capabilityId',v_detail,p_command_id,p_fail='fail');
 RETURN QUERY SELECT 'applied'::text,v_effect;
END $$;
REVOKE ALL ON FUNCTION morrow_work.lab_claim_consumer(text,text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.lab_claim_consumer(text,text,text,text,text,text,text,text,text) TO morrow_work_api;
GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.lab_claim_consumer(text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;
COMMIT;
