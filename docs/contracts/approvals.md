# Exact proposal approvals

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P11.

## Shape and ownership

Schemas: Proposal, Approval, CrossHostResume. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Compute proposal digest from canonical content using a RFC 8785 JSON Canonicalization Scheme ([specification](https://www.rfc-editor.org/rfc/rfc8785/)) and SHA-256. Bind resource/account/field/parameter/cost/prior-version/review-policy contents. Decisions identify reviewer and current eligibility, exact digest, scope digest and expiry. Selected-item approval creates an exact selected change set. Changes invalidate review. Approval itself requires an eligible decision grant, not a recursively approved approval. Execution still needs an independent eligible grant and current provider authority.

## Failure invariant

Wrong revision, changed ceiling, replayed handoff, expired review or ineligible reviewer blocks dispatch. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.

## Contract v1.1: kill switches (P01.T02a PR-A)

ADR-0005 makes five capabilities kill switches: `ads.campaign.pause`, `agents.installation.disable`, `governance.membership.revoke`, `governance.connection.disconnect` and `agents.release.revoke`. Each is `human_only`, with `review_required: false`, so it executes without a second approver and creates no Approval. It still needs a current eligible human grant for `execute`. Its v1.1 input carries a `KillSwitchControl`: a reason with at least one non-whitespace character, and an optional `sourceProposalRef`. The human evaluator returns the `kill_switch_record` obligation in place of `exact_approval`: the effect commits with an append-only `KillSwitchRecord`, and the owner notification derives from that record (P05.T01z, P11.T05). An agent may propose a stop. A human executing it from that proposal passes the proposal as `sourceProposalRef`, which is rechecked for the same tenant, the same capability and covering targets, and confers nothing (`packages/policy/src/kill-switch.ts`).

Reversals keep review: unpause (`ads.campaign.activate`), re-enable (`agents.installation.activate`), reconnect (`governance.connection.connect`), re-invite (`governance.membership.invite`), re-grant (`governance.grants.revise`) and republish (`agents.release.publish`) still require `exact_approval`. The review policy (ReviewPolicy, Proposal@2, Approval@2) is PR-B under ADR-0011. Versioning is described in contract-versions.md.
