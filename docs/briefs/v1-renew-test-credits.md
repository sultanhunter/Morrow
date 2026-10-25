# v1 PR 6: Credits for your own workspace (renew the test credits)

- Status: brief, 2026-10-25. Build order PR 6 ([v1-build-order.md](../plan/v1-build-order.md)), under [ADR-0035](../decisions/adr/ADR-0035-build-v1-live.md) items 3 and 4 (the owner's workspace keeps getting test credits under the standing approval; more than 300 credits in 30 days is raising a limit) and [billing-entitlements R10](../contracts/billing-entitlements.md) (credits come only from the versioned `BillingTerms`). Branch `claude/v1-renew-test-credits`, from `main` `66689751`.
- Migration `0052.staging-test-credits-renewal.sql` (work owner): the next free number on `main`. Open PRs already hold 0052 to 0054, so integration renumbers it.

## Goal

Today `staging:test-entitlement` gives the owner's workspace 300 test credits for 30 days, once. This PR lets the lead renew them with one command, once per 30-day period, until Shopify billing exists. No money changes hands, and the Anthropic monthly limit stays the outside cap (the credits-only decision of pull request 75, item 6).

```
npm run staging:test-credits -- renew --operator <id>
```

## Scope

- **Migration 0052:**
  - `morrow_billing.operator_test_entitlement_renewals`: one row per renewed period of a grant, with the terms revision its credits came from. It is append-only, owner only, FORCE RLS, and holds one row per grant and period.
  - `wallet_guard` and `snapshot_guard` are replaced, and only when they still have 0035's exact bodies (md5 pins). The owner may fund the wallet revision a renewal names with exactly the units it added. An operator snapshot's successor must be the same grant's renewal for that revision, from the owner, and must start no earlier than the previous period ended. Everything 0035 refused is still refused.
  - `morrow_billing.operator_test_entitlement_renew(operator, workspace, grant approval, standing approval, evidence)`: five closed text values, none an amount. INVOKER, owned by the owner, granted to nobody. It returns `renewed`, `current` (the period that contains the clock is already written, so nothing is written), `grant_missing`, `route_conflict`, `terms_missing`, `not_staging`, `invalid` or `denied`.
- **Periods:** the grant's period is period 0. Period k starts (k − 1) × 720 hours after the grant's period ended and lasts 720 hours. A renewal writes only the period that contains the database's clock, so a lapsed period is never back-filled.
- **Credits** come only from the versioned terms (R10): the current `BillingTerms` revision's one `operator_test_entitlement` entry (300 in staging revision 1), read exactly as 0035's grant reads it, so the source is the one the grant's own credits came from. No argument, record or CLI flag names an amount. A renewal tops the unspent credits (available plus reserved) up to that entry and never above it, so unused credits do not pile up beyond one period's credits. Raising them is a new staging `BillingTerms` revision (ADR-0035 item 4: only with the owner's yes for that use); the next renewal reads it, and the current period keeps the credits it was written with. Terms without the one operator entry refuse a due period (`terms_missing`).
- **Committed record** `docs/decisions/test-credits-staging.json`, read at verified `main` as a git blob: the owner's workspace id and the grant's approval reference (`adr-0035.e13.<date>.<n>`, from the grant's printed result), and nothing else (no amount). It is committed unset (`null`), so `renew` refuses (`STAGING_TEST_CREDITS_UNSET`) until a routine commit fills it in. The workspace is never a command-line value.
- **Runner** `renewTestCredits`: one administrator transaction under the D4 SET-row protocol.
  - As `morrow_identity_owner`, it checks that the environment's active live-store app invites this workspace. This check is shared with `grantTestEntitlement`.
  - Then, as `morrow_work_owner`, it runs the function.
  - Only `renewed` or `current` commits. A failed COMMIT after `renewed` is `STAGING_TEST_CREDITS_OUTCOME_UNKNOWN`: rerun `renew`, which reads it back as `current` if it committed.
- **CLI** `test-credits renew`:
  - It is refused in CI, without the standing approval (and its E13), off a clean `main` at `origin/main` with `foundation` green, and on any binding other than staging's.
  - It reads the owner database URL in-process and never prints it.
  - It prints one closed JSON line on stdout. A notice on stderr gives the exact activity-log line to append. That line carries no workspace id, shop domain, store data or secret.

Non-goals: ADR-0026 item 7's `TestEntitlementSeed`, Shopify billing, any change to the grant or checkout, any money cap.

## Interfaces touched

- `migrations/0052*` and the manifest.
- `scripts/staging.mjs` (`test-credits`; shared `requireE13`, `labelledValues` and `committedBlob`).
- `scripts/staging-runner.mjs` (`renewTestCredits`; the shared live-store check).
- `package.json` (`staging:test-credits`).
- `docs/decisions/test-credits-staging.json`.
- The tenant-conformance registry.
- `docs/contracts/billing-entitlements.md`, `docs/decisions/data-lifecycle.md`, `docs/development/ci.md` and the V1-PR06 node.

## Security notes

- **Only the owner's workspace.** It must be named in the committed record and invited by the active live-store app (read as the identity owner in the same transaction). Its grant must be the one under the recorded approval reference, and the route, account, wallet and latest snapshot must all be that grant's.
- **Staging only.** The binding must be staging's, the owner URL must name the bound host and database, and the database's mark must say `staging`. Labs and unit tests use fakes or a local engine. CI never runs it.
- **Never a payment.** No receipt, payment event or `credit_grants` row is written. The route, account and grant record are unchanged.
- **Credits from the terms only (R10).** No caller value can change a period's credits; each renewal records the terms revision they came from, in its row, its digest and its result.
- **No new authority.** No runtime login, role or definer gains anything. The function is INVOKER, granted to nobody, and refuses any session, lease or receipt context and any Morrow login.
- **No money cap is added** (the credits-only decision of pull request 75). The 720-hour period and the top-up rule bound test credits, not spend.

## Lead steps after merge

1. Run `staging:migrate` to apply 0052.
2. Run the grant (`staging:test-entitlement`) if it has not run yet.
3. Commit the record with the workspace id and the grant's approval reference.
4. After the grant's period ends, run `staging:test-credits -- renew --operator <id>`.
5. Append the printed line to `docs/evidence/activity-log.md`.

## Review findings

- **F1 (high, AI review, separate context, same model family).** The first draft let the caller name the period's credits (`p_credit_units` with `p_raise_evidence_ref`, from a `raise` member of the committed record), so credits could be funded from a value outside `BillingTerms`. That broke R10, ADR-0022's "the terms stay the only source of credit units" and this PR's own safety test, and it was a material billing change with no accepted ADR. **Fixed:** the two parameters, the `raise_evidence_ref` column, the record's `raise` member, `requireTestCreditsRaiseRecord` and the CLI wiring are gone. Each period's credits are the current terms' operator entry, read as 0035's grant reads it, and the renewal records `terms_revision`. The runner's input is closed to five values, and the psql lab fixture's null binding (added only for the raise) is reverted. Tests: the migration test pins the terms read to 0035's text and the five-value signature; the input, record and CLI tests refuse any amount; lab N cases show that no caller value names the credits, that a new terms revision changes the next renewal's credits but not the current period's, and that terms without the operator entry refuse.

## Open questions

- Raising the owner's test credits is a staging `BillingTerms` revision. ADR-0039 (pull request 75, not yet accepted) names that mechanism. Under ADR-0035 item 4, each raise needs the owner's yes in chat before the revision is published. If the owner wants another raise mechanism, it needs its own decision; this PR builds none.

## Test checklist

- [x] Unit, `tests/staging-test-credits.test.mjs`:
  - the migration's shape and pins;
  - the closed input and result;
  - the D4 statement order;
  - commits only on `renewed` or `current`;
  - the unknown COMMIT;
  - the record's grammar, unset state and approval rules, and no amount in it;
  - credits only from the terms: the terms read is 0035's, and no input names an amount (F1);
  - the activity-log line;
  - CLI refusals before any SQL: usage, CI, approval, binding, `main`, a dirty tree, a missing, unset, malformed or symlinked record, the standing record, and a record that names an amount;
  - no owner URL in any output.
  - `tests/staging-deploy.test.mjs` lists the command.
- [x] `lab:test-entitlement` (pg-http), 14 new checks (one S, thirteen N), 40 in all.
- [x] `lab:tenant-conformance` (the new table and function registered), 17 of 17.
- [ ] Tier 2 AI review (separate context, same model family) with the security lens.
- [ ] Hosted CI on the PR head.
