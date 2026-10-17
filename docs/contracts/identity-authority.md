# Identity and authority

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P05.

## Shape and ownership

Schemas: ActorRef, Scope, Grant, PolicyDecision. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Trusted identity resolves organization/workspace membership. Installation tokens are provider authority, not human authority. Effective permission is the intersection of current human/automation owner, initiating task envelope, installation grants, resource/field grants, provider constraints and policy. Verbs view/propose/approve/execute/delegate/administer are distinct. No wildcard grants in this baseline. Declared ownership/responsibility never grants access. Revocation increments policy revision and invalidates cached allow decisions before later retrieval or dispatch.

## Failure invariant

Wrong-tenant identifiers return a redacted denied result. Reviewer cannot approve an action to which no eligible execution grant exists. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.


## Internal workspace access revocation

Canonical61/P05.T01c adds a local persistence primitive with a separate dedicated executor. It is not a public capability implementation or an organization-wide membership command. No production receipt issuer or approval issuer exists; only isolated laboratory maintenance can seed synthetic authorization receipts.

The exact receipt pins organization, workspace, initiating human membership and session digest, target membership, command ID, request digest, expected organization policy revision, immutable approval-evidence ID and expiry, plus a validated authorizing-grant payload. Every binding must match; a request digest, session digest or receipt ID alone grants no authority. The narrow SQL function checks current locked authority and pinned grant facts after serialization waits. Its private receipt/result tables use tenant foreign keys and FORCE RLS. Neither the ordinary API database role nor agent runtime can invoke it, assume its executor role or write these tables.

One committed transaction deactivates the selected workspace membership, revokes that workspace's target grants, increments organization policy revision and saves receipt consumption plus attributable audit/result. It preserves organization membership, organization-scoped sessions, principal activity and other workspace grants. A preserved session immediately fails current identity resolution in the revoked workspace. Existing permission reads reload current SQL facts and never cache allows.

Exact repeated commands return their original result only after current initiating authority is rechecked. Changed bindings cannot replay that result. Exactly bound expected denials commit a redacted terminal audit without an access mutation. Unexpected database failures roll back; a lost COMMIT acknowledgement remains uncertain, even if a later rollback succeeds. Reconcile the same stable command before creating any new operation. Do not treat an unavailable reply as evidence that revocation failed.

This local operation does not return the public capability's affectedRuns field or cancel runs. Full approval issuance, organization-wide revocation, grant issuance, provider identity and command/dispatch fencing remain separate qualification work.


## Private PKCE and code admission

Canonical69/P05.T01d adds a private pre-authentication admission ledger with exact owner application/configuration and browser/PKCE commitments. One fresh committed reservation is correlation only; it creates no principal, session, membership, grant or provider success. Exact repeats and read-only reconciliation return held correlation, never a second reservation. Unknown commit/release remains uncertain and is not automatic retry authority. Future provider broker/issuer/HTTP transport remain separately qualified. Immutable migration6 excludes PKCE-managed challenges from the old legacy consumer while leaving its historical-only behavior available. No raw code/verifier/browser state is persisted or logged. The detailed canonical protocol and bounded packet govern its SQL roles, locks, late expiry rollback and checks.

## Contract v1.1: human executors and kill switches (P01.T02a PR-A)

`HumanActorRef` (core v1.1) is an ActorRef with kind `human`, a workspace and a membership, and no installation or mandate. It is the actor of every `KillSwitchRecord`. The human evaluator (`packages/policy/src/index.ts`) allows a current human grant holder to execute a kill switch with no approval, returning `recheck_at_dispatch` and `kill_switch_record` (plus `provider_effect_verification` for the external pause). A dispatcher that does not implement an obligation denies dispatch.

Kill-switch targets are checked by `checkKillSwitchTarget` after the evaluator allows `execute`. Every ref and every record an ID resolves to must be in the trusted organization and workspace, and a campaign's store and connection must fit one current grant; unknown, foreign-tenant and ungranted targets give the same `TARGET_NOT_FOUND` result. The designated owner's membership cannot be revoked through the kill switch (`OWNER_MEMBERSHIP_PROTECTED`); ownership must first move by a reviewed transfer (P05.T01z). Every revocation is flagged as a membership change, which advances `lastMembershipChangeAt` in `WorkspaceOwnershipFacts` (`packages/policy/src/review-facts.ts`). Only trusted readers fill those facts; P05.T01z supplies them from the ADR-0009 owner record and enforces owner protection in SQL.
