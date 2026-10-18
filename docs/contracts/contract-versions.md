# Contract versions

Owner: Morrow platform owner. Decisions: ADR-0005 (kill switches, executor classes) and ADR-0011 Q0 (versioning). Packet: P01.T02a. This file describes how contract versions are built and checked; the schemas themselves are the authority.

## Contract sets

| Version | Files | Status |
| --- | --- | --- |
| `morrow.contracts.v1` | `schemas/v1/{core,capabilities,billing}.schema.json` | `frozen` |
| `morrow.contracts.v1.1` | the three v1 files, byte-identical, plus `schemas/v1.1/{core,capabilities}.schema.json` | `candidate_owner_signoff`, current |

- Billing stays at v1. v1.1 refers to v1 by absolute URI (`urn:morrow:contracts:core:v1#/$defs/Id`); v1 never refers to v1.1.
- `scripts/contract-sources.mjs` is the one source of the version string and of the ordered schema list. `packages/contracts` re-exports `contractVersion` from the generated `domain.ts`; `GET /health` on the api and the workers scaffold reports it.
- The source list is append-only. Generated validator names and type prefixes follow its order (`Core_`, `Capability_`, `Billing_`, `CoreV1_1_`, `CapabilityV1_1_`), so appending a source keeps existing names stable.
- The Tier 3 P01 contract sign-off flips v1.1 to `frozen`. Until then a change to v1.1 is a deliberate edit of `release-baseline.json`. After it, additions open `schemas/v1.2/`.

## Replacements

A v1.1 definition that reuses a v1 name, or a v1.1 capability body that overrides a v1 body, is a **replacement**. Replacements are not compatible with the v1 shape in either direction: the objects are closed, and required properties are added, dropped or retyped (Proposal@2 and Approval@2 in PR-B also change their const `schemaVersion`). Nothing is deployed, so writers emit only the current shape. Each replacement is listed in `schemas/v1.1/changes.json` as `{kind, name, replaces, reason, adr}`.

PR-A of P01.T02a declares five `capability_body` replacements, all under ADR-0005:

| Capability | v1 input | v1.1 input |
| --- | --- | --- |
| `ads.campaign.pause` | `{proposalRef, approvalRef}` | `{campaigns: CampaignRefs, control: KillSwitchControl}` |
| `agents.installation.disable` | `{installationId, expectedRevision}` | `{installationId, control}` |
| `governance.membership.revoke` | `{membershipId, expectedRevision}` | `{membershipId, control}` |
| `governance.connection.disconnect` | `{connectionId, expectedRevision}` | `{connectionId, control}` |
| `agents.release.revoke` | `{releaseRef, reason}` | `{releaseRef, control}`; `control.reason` replaces `reason` |

Outputs are unchanged. A stop has no `expectedRevision`: it is an idempotent target state, so an unrelated revision bump never fails it. Commands stay idempotent per (workspace, `commandId`, `requestDigest`).

PR-B declares three more replacements, all under ADR-0011:

| Replacement | v1 | v1.1 |
| --- | --- | --- |
| `Proposal` (definition) | `schemaVersion` 1, one optional `maximumCost`, any `risk` | Proposal@2: `schemaVersion` 2; per-target and total `maximumCredits` and `maximumCost`; server-derived `irreversible`, `requestedBy` (a `HumanActorRef`), `beneficiaryPrincipalIds` and `contextTaint`; `partialApproval` and `derivedFrom`; `taskId` null only for a human-made Governance-domain proposal, whose `requestedBy` is the proposer (ADR-0018) |
| `Approval` (definition) | `schemaVersion` 1, any `ActorRef` reviewer | Approval@2: `schemaVersion` 2; human reviewers only; `reviewPolicyRef`, `requiredApprovals`, `decisions` and `effectiveAt` |
| `governance.approval.decide.input` | `{proposalRef, decision: DecisionRef, expectedRevision}` | `{proposalRef, decision: ReviewDecisionInput, expectedRevision}` |

PR-B also adds the bodies of two new capabilities, `governance.review_policy.revise` and `governance.approval.preview`. They have no v1 body, so they are additions, not replacements.

The ADR-0018 follow-up edits Proposal@2 while v1.1 is a candidate: `taskId` becomes `Id | null`, and a null `taskId` requires a human `proposedBy` (an `allOf` rule). The review library adds the Governance-domain rule and the `requestedBy` derivation. It is a deliberate edit of the candidate: the `Proposal` entry in `changes.json` keeps its place and records the edit in its reason, and the baseline hash of `schemas/v1.1/core.schema.json` is updated. If v1.1 had been frozen, the edit would have opened `schemas/v1.2/` instead.

New v1.1 definitions in PR-A: `HumanActorRef`, `KillSwitchControl`, `CampaignRef`, `CampaignRefs` and `KillSwitchRecord`. In PR-B: `NonNegativeDecimal`, `NonNegativeMoney`, `RiskClass`, `SelectionIndexes`, `TargetSelection`, `ProposalTarget`, `ProposalDerivation`, `ReviewRule`, `RestrictedReviewRule`, `SoloOwnerRule`, `ReviewPolicyRules`, `ReviewPolicy`, `ApprovalDecision` and `ReviewDecisionInput`. Credit ceilings reuse billing v1 `CreditUnits` by absolute URI. `KillSwitchRecord.capabilityId` is limited to the five kill switches, and its `targets` are v1 `ResourceRef`s: a campaign uses kind `campaign`, an installation `installation`, a membership `member` and a release `release`; `KillSwitchTargetKind` (`packages/policy/src/review-facts.ts`) uses the same kinds. v1 `ResourceRef` has no kind for a store connection, so how a disconnect names its target is open; P05.T01z settles it with a deliberate v1.1 edit before sign-off.

## Effective selection

- A definition resolves to `core-v1.1:<Name>` if it exists, otherwise `core:<Name>`.
- A capability body resolves to `capabilities-v1.1:<id>.<io>` if it exists, otherwise `capabilities:<id>.<io>`.

The generated bundle `packages/contracts/src/generated/runtime-validators.mjs` exports three frozen maps: `validators` (every exact selector), `currentDefinitionSelectors` and `capabilityBodySelectors`. `packages/contracts/src/validation.ts` exposes:

- `validateCapabilityInput` and `validateCapabilityOutput`: the effective body. Product code and the typed client use these.
- `validateCurrentDefinition(name, value)`: the effective definition. Product code uses this.
- `validateDefinition(schema, name, value)` with `schema` one of `core`, `billing` or `core-v1.1`: an exact selector, kept for the frozen baseline, historical fixtures and tests.

The generated types follow the same rule: `CapabilityInput<K>` is the effective body, and `Current_<Name>` aliases (with `CurrentDefinitions` and `CurrentDefinitionName`) name the effective definitions. The v1 types stay exported for history.

Validators are generated ahead of time with one Ajv 2020 instance (`npm run contracts:generate`). No schema is compiled at runtime, and the workerd lab runs every selector with code generation denied. Contract v1.1 grew the bundle from 1,594,826 to 1,658,971 bytes in PR-A (about 4 percent), and to 1,837,054 bytes in PR-B (about 11 percent more, 15 percent over v1). The ADR-0018 edit of Proposal@2 brought it to 1,839,756 bytes.

## Checks

| Check | Where | Failure |
| --- | --- | --- |
| Hashes of every baselined schema | `inspectCompatibility` (`scripts/boundary-checks.mjs`) | `UNREVIEWED_SCHEMA_DELTA:<path>` |
| Every `docs/contracts/schemas/**/*.schema.json` is baselined | `inspectBaselineCoverage` | `UNBASELINED_SCHEMA:<path>` |
| Every replacement is declared, and every declaration names a real replacement | `inspectDeclaredReplacements` | `UNDECLARED_REPLACEMENT:<name>` |
| Generated output matches the sources | `generate-contracts.mjs --check`, `generate-runtime-validators.mjs --check` | drift error |
| The catalogue describes the effective bodies | `validateCatalogue` rule R11 (`scripts/foundation.mjs`) | `R11 ...` |
| Product code under `apps/` and `packages/` never validates or types a replaced v1 definition: `validateDefinition("core", <replaced>)`, a `"core:<replaced>"` selector or a `Core_<replaced>` type | `inspectSupersededUse` (replaced names read from `changes.json`; generated files exempt) | `SUPERSEDED_CONTRACT_USE:<file>:<name>` |

`npm run verify:boundaries` runs the first four and the last with deliberate negative examples. `tests/contract-versioning.test.mjs` covers P01.T02a AC01-AC05, AC10 and AC11.

## Transitions

`state-transitions.json` rows may carry `since` (the version that adds the row), `superseded_in` (the version from which it no longer applies) and `capability` (the capability that performs it). `inspectTransition(fixture, version)` in `scripts/contract-checks.mjs` uses only the rows in force at that version, `1` or `1.1` (default: the current version). In 1.1 the v1 approval rows guarded by `exact_digest_scope_and_current_policy` are superseded by the quorum, solo-owner, rejection, cancellation and partial-approval rows, and tasks gain `draft→cancelled` and `ready→cancelled` (`workspace.task.cancel`, ADR-0010 item 5).

## Baseline

`release-baseline.json` keeps a flat `schemas` map of path to SHA-256, so `inspectCompatibility` is unchanged. It records `"current": "morrow.contracts.v1.1"` and a `versions` map with each version's status. Generation never writes the baseline.
