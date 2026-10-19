# Contract versions

Owner: Morrow platform owner. Decisions: ADR-0005 (kill switches, executor classes), ADR-0011 Q0 (versioning) and ADR-0015 (the billing layer). Packets: P01.T02a and P01.T04a. This file describes how contract versions are built and checked; the schemas themselves are the authority.

## Contract sets

| Version | Files | Status |
| --- | --- | --- |
| `morrow.contracts.v1` | `schemas/v1/{core,capabilities,billing}.schema.json` | `frozen` |
| `morrow.contracts.v1.1` | the three v1 files, byte-identical, plus `schemas/v1.1/{core,capabilities,billing}.schema.json` | `candidate_owner_signoff`, current |

- Billing gains a v1.1 layer (`schemas/v1.1/billing.schema.json`, `urn:morrow:contracts:billing:v1.1`; ADR-0015, P01.T04a), because billing v1 can describe only a shop-owned account. v1.1 refers to v1 by absolute URI (`urn:morrow:contracts:core:v1#/$defs/Id`, `https://morrow.local/contracts/v1/billing.schema.json#/$defs/CreditUnits`); v1 never refers to v1.1.
- `scripts/contract-sources.mjs` is the one source of the version string and of the ordered schema list. `packages/contracts` re-exports `contractVersion` from the generated `domain.ts`; `GET /health` on the api and the workers scaffold reports it.
- The source list is append-only. Generated validator names and type prefixes follow its order (`Core_`, `Capability_`, `Billing_`, `CoreV1_1_`, `CapabilityV1_1_`, `BillingV1_1_`), so appending a source keeps existing names stable. A later source is appended after every source present on `main` at rebase time; `tests/contract-versioning.test.mjs` pins the kinds, paths and prefixes in order.
- The Tier 3 P01 contract sign-off flips v1.1 to `frozen`. Until then a change to v1.1 is a deliberate edit of `release-baseline.json`. After it, additions open `schemas/v1.2/`.

## Replacements

A v1.1 definition that reuses a v1 name, or a v1.1 capability body that overrides a v1 body, is a **replacement**. Replacements are not compatible with the v1 shape in either direction: the objects are closed, and required properties are added, dropped or retyped (Proposal@2 and Approval@2 in PR-B also change their const `schemaVersion`). The one exception is billing `AllocationShare@2`, a superset of v1 (see the billing layer below). Nothing is deployed, so writers emit only the current shape. Each replacement is listed in `schemas/v1.1/changes.json` as `{kind, name, replaces, reason, adr}`.

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

P05.T01x Part B (ADR-0009 item 5) adds three v1.1 definitions for the account routes, all additions and none a replacement, so `changes.json` is unchanged: `AccountOverview` (`GET /workspaces`), `OrganizationSignupRequest` and `OrganizationSignupResult` (`POST /organizations`). The baseline hash of `schemas/v1.1/core.schema.json` was updated deliberately; the bundle grew to 1,857,713 bytes.

P05.T01y (ADR-0004) adds one v1.1 definition, `SessionRotationResult` (the `POST /auth/rotate` 200 body), an addition and not a replacement, so `changes.json` is unchanged. The baseline hash of `schemas/v1.1/core.schema.json` was updated deliberately; the generated validator bundle is 2,207,978 bytes.

The ADR-0018 follow-up edits Proposal@2 while v1.1 is a candidate: `taskId` becomes `Id | null`, and a null `taskId` requires a `governance.*` `capabilityId` and a `HumanActorRef` `proposedBy` (an `allOf` rule). The review library adds the catalogue Governance-domain check, the task binding and the `requestedBy` derivation, which JSON Schema cannot express. It is a deliberate edit of the candidate: the `Proposal` entry in `changes.json` keeps its place and records the edit in its reason, and the baseline hash of `schemas/v1.1/core.schema.json` is updated; with the Part B definitions the bundle is 1,860,473 bytes. If v1.1 had been frozen, the edit would have opened `schemas/v1.2/` instead.

New v1.1 definitions in PR-A: `HumanActorRef`, `KillSwitchControl`, `CampaignRef`, `CampaignRefs` and `KillSwitchRecord`. In PR-B: `NonNegativeDecimal`, `NonNegativeMoney`, `RiskClass`, `SelectionIndexes`, `TargetSelection`, `ProposalTarget`, `ProposalDerivation`, `ReviewRule`, `RestrictedReviewRule`, `SoloOwnerRule`, `ReviewPolicyRules`, `ReviewPolicy`, `ApprovalDecision` and `ReviewDecisionInput`. Credit ceilings reuse billing v1 `CreditUnits` by absolute URI. `KillSwitchRecord.capabilityId` is limited to the five kill switches, and its `targets` are v1 `ResourceRef`s: a campaign uses kind `campaign`, an installation `installation`, a membership `member` and a release `release`; `KillSwitchTargetKind` (`packages/policy/src/review-facts.ts`) uses the same kinds. v1 `ResourceRef` has no kind for a store connection, so how a disconnect names its target is open; P05.T01z settles it with a deliberate v1.1 edit before sign-off.

## Billing layer (P01.T04a, ADR-0015)

`schemas/v1.1/billing.schema.json` adds 19 definitions and replaces five billing v1 definitions, each declared in `changes.json` as kind `billing_definition` with `replaces: "billing:<Name>"`:

| Replacement | v1 | v1.1 |
| --- | --- | --- |
| `BillingAccount` | `schemaVersion` 1, `provider: "shopify_app_pricing"`, required installation and store | `schemaVersion` 2; `route` and `mode`; a storeless Morrow-direct branch (never `uninstalled`) or a Shopify branch with its installation and store |
| `EntitlementSnapshot` | `schemaVersion` 1, shop-only | `schemaVersion` 2; `route` and `mode`; `subscriptionId` holds the route's `SubscriptionKey` |
| `CreditGrant` | `schemaVersion` 1 | `schemaVersion` 2; `route`, `mode` and the `PaymentKey` that makes it unique; a Shopify grant is always `included` |
| `AllocationShare` | required installation and store | both null (Morrow-direct payer) or both set (Shopify payer). A superset of v1: a v1 share is a valid store-bound share. This is safe because a share is stored only inside a `CostAllocation`, whose `schemaVersion` keeps v1 and v1.1 allocations apart |
| `CostAllocation` | `schemaVersion` 1 over v1 shares | `schemaVersion` 2 over v1.1 shares |

New definitions: `BillingRoute`, `PaymentMode`, `StripePaymentKey`, `ShopifyPeriodKey`, `ShopifyPlanChangeKey`, `PaymentKey`, `StripeSubscriptionKey`, `ShopifySubscriptionKey`, `SubscriptionKey`, `StripePriceKey`, `ShopifyPriceKey`, `PriceKey`, `UsdBillingMoney`, `WorkspaceBillingRoute`, `VerifiedPaymentEvent`, `PaymentReversal`, `BillingTerms`, `UsageCap` and `TestEntitlementSeed` (ADR-0015 follow-up decision OQ-2 (a)). The semantics are in `billing-entitlements.md`. Couplings are `oneOf` branches of closed objects. Every Shopify-route amount and currency is USD (App Pricing prices are USD only): event `amountPaid`, reversal `amount`, terms entry `currency`, account `currency` and `UsageCap.maximumLiability`. Every key is a valid core `Id`; Shopify GID tails have no leading zeros and times are UTC to the second, so each provider object has one key.

If v1.1 is frozen before a later billing addition merges, that addition opens `schemas/v1.2/billing.schema.json` (kind `billing-v1.2`, prefix `BillingV1_2`) with replacements in `schemas/v1.2/changes.json`.

## Effective selection

- A definition resolves to `core-v1.1:<Name>` if it exists, otherwise `core:<Name>`.
- A billing definition resolves to `billing-v1.1:<Name>` if it exists, otherwise `billing:<Name>` (`billingLayers` in `scripts/contract-sources.mjs`).
- A capability body resolves to `capabilities-v1.1:<id>.<io>` if it exists, otherwise `capabilities:<id>.<io>`.

The generated bundle `packages/contracts/src/generated/runtime-validators.mjs` exports four frozen maps: `validators` (every exact selector), `currentDefinitionSelectors`, `capabilityBodySelectors` and `currentBillingDefinitionSelectors`. `packages/contracts/src/validation.ts` exposes:

- `validateCapabilityInput` and `validateCapabilityOutput`: the effective body. Product code and the typed client use these.
- `validateCurrentDefinition(name, value)`: the effective definition. Product code uses this.
- `validateCurrentBillingDefinition(name, value)`: the effective billing definition. Product code uses this.
- `validateDefinition(schema, name, value)` with `schema` one of `core`, `billing`, `core-v1.1` or `billing-v1.1`: an exact selector, kept for the frozen baseline, historical fixtures and tests.

Browser code never imports that bundle (P05.T01y). For each name in the closed list `browserValidatorDefinitions` (`scripts/contract-sources.mjs`; today `SessionRotationResult`), the generator also emits `packages/contracts/src/generated/validators/<Name>.mjs`, imported as `@morrow/contracts/validators/<Name>`. It exports only `validate<Name>`: the table's compiled validator for the effective selector, from the same Ajv instance, emitted without the table (the generator checks that the table exports the same function and contains its code byte for byte). The UI import allowlist (`scripts/boundary-checks.mjs`) admits exactly these specifiers and never `@morrow/contracts/validation` or `@morrow/contracts/client`, and `verify:workspace-web` denies the table in every browser bundle.

The generated types follow the same rule: `CapabilityInput<K>` is the effective body, `Current_<Name>` aliases (with `CurrentDefinitions` and `CurrentDefinitionName`) name the effective definitions, and `CurrentBilling_<Name>` aliases (with `CurrentBillingDefinitions` and `CurrentBillingDefinitionName`) the effective billing definitions. The v1 types stay exported for history.

Validators are generated ahead of time with one Ajv 2020 instance (`npm run contracts:generate`). No schema is compiled at runtime, and the workerd lab runs every selector with code generation denied. Contract v1.1 grew the bundle from 1,594,826 to 1,658,971 bytes in P01.T02a PR-A (about 4 percent), and to 1,837,054 bytes in P01.T02a PR-B (about 11 percent more, 15 percent over v1). The ADR-0018 edit of Proposal@2 alone brought it to 1,839,814 bytes, and with the P05.T01x Part B account definitions it reached 1,860,473 bytes. The billing layer (P01.T04a) brings it to 2,202,717 bytes (about 18 percent more; 123,495 to 146,710 bytes gzipped).

## Checks

| Check | Where | Failure |
| --- | --- | --- |
| Hashes of every baselined schema | `inspectCompatibility` (`scripts/boundary-checks.mjs`) | `UNREVIEWED_SCHEMA_DELTA:<path>` |
| Every `docs/contracts/schemas/**/*.schema.json` is baselined | `inspectBaselineCoverage` | `UNBASELINED_SCHEMA:<path>` |
| Every replacement is declared, and every declaration names a real replacement | `inspectDeclaredReplacements` | `UNDECLARED_REPLACEMENT:<name>` |
| Generated output matches the sources, including each per-definition browser module, and the browser validators directory holds nothing else | `generate-contracts.mjs --check`, `generate-runtime-validators.mjs --check` | drift error |
| The catalogue describes the effective bodies | `validateCatalogue` rule R11 (`scripts/foundation.mjs`) | `R11 ...` |
| Product code under `apps/` and `packages/` never validates or types a replaced v1 definition: `validateDefinition("core", <replaced>)`, a `"core:<replaced>"` selector or a `Core_<replaced>` type, and the same with `"billing"`, `"billing:"` and `Billing_` for a replaced billing definition | `inspectSupersededUse` (replaced names read from `changes.json`; generated files exempt) | `SUPERSEDED_CONTRACT_USE:<file>:<name>` |
| Only the billing constraints reader and its two forwarders set a non-false `entitlementAllowed` in product code (P01.T04a §2) | `inspectEntitlementWriters` | `ENTITLEMENT_WRITER_UNAPPROVED:<file>:<line>` |

`npm run verify:boundaries` runs the first four and the last two with deliberate negative examples. `tests/contract-versioning.test.mjs` covers P01.T02a AC01-AC05, AC10 and AC11, and P01.T04a AC11, AC29 and AC30.

## Transitions

`state-transitions.json` rows may carry `since` (the version that adds the row), `superseded_in` (the version from which it no longer applies) and `capability` (the capability that performs it). `inspectTransition(fixture, version)` in `scripts/contract-checks.mjs` uses only the rows in force at that version, `1` or `1.1` (default: the current version). In 1.1 the v1 approval rows guarded by `exact_digest_scope_and_current_policy` are superseded by the quorum, solo-owner, rejection, cancellation and partial-approval rows, and tasks gain `draft→cancelled` and `ready→cancelled` (`workspace.task.cancel`, ADR-0010 item 5).

## Baseline

`release-baseline.json` keeps a flat `schemas` map of path to SHA-256, so `inspectCompatibility` is unchanged. It records `"current": "morrow.contracts.v1.1"` and a `versions` map with each version's status. Generation never writes the baseline.
