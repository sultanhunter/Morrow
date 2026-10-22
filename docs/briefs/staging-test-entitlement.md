# Staging test entitlement

- Status: brief, 2026-10-22. Owner decision (b) of 2026-10-21 ("Staging test entitlement (Recommended)"; quoted in [M5-billing.md](M5-billing.md)). Material choices: the ADR-0022 item 5 amendment (2026-10-21) and the staging-card-1 E13 amendment, both in this PR.
- Plan IDs: P18.T01a (the Morrow-direct route), with its persistence items 3–5 of `docs/contracts/billing-entitlements.md`. Branch `claude/staging-test-entitlement`, from `claude/m5-billing` (it writes M5's billing tables); one PR, opened after PR #37 (M5 PR-1) merges. Migrations `0034` and `0035` here: first written as 0030 and 0031, renumbered after M3 PR-1's 0030–0033 when the merge train stacked this branch on `claude/m3-listings-agent` (2026-10-22).

## Goal

While the Stripe switch is off, the owner can put one named staging workspace on the beta plan (300 test credits) without Stripe, so that workspace can link the development store and run the Listings agent. Each use is approved by the owner in chat and recorded. Production still needs a real Stripe payment.

## Scope

- **Migration `0034.staging-entitlement-identity-bridge.sql`** (as `morrow_identity_owner`): grants `morrow_work_owner` EXECUTE on M2 PR-2's store-installation read, `morrow_identity.work_store_installations` (ids and states only, never a shop domain; until now executable by the command role alone), so the operator function can apply the phase-open rule. Nothing else changes; no runtime login, role or definer gains anything.
- **Migration `0035.staging-test-entitlement.sql`** (as `morrow_work_owner`):
  - `morrow_billing.platform_environment`: the database's one environment mark, written once and never changed.
  - `morrow_billing.operator_test_entitlements`: the operator grant record. It holds the approval reference, the operator, the live record's path, the credits and terms revision, the 30-day period and a digest. It is append-only, owner-only and one per workspace and per approval.
  - Forward changes to 0020 and 0029 so those tables can hold it:
    - the route variant admits `morrow:operator_entitlement:<id>` in test mode;
    - a snapshot names either a receipt or an operator entitlement;
    - a terms revision may carry one `operator_test_entitlement` entry and no offer;
    - `wallet_guard`, `snapshot_guard`, `route_fix_guard` and `terms_guard` admit these only from the owner and only for the grant of the same tenant.
  - `morrow_billing.operator_test_entitlement_grant(operator, workspace, approval, record)`: the operator function (owned by the owner, INVOKER, granted to nobody).
- **Contract v1.1 billing:** `OperatorEntitlementKey`; test-mode Morrow-direct variants of `WorkspaceBillingRoute` and `EntitlementSnapshot`; the `BillingTerms` operator entry. `CreditWallet` and `CreditGrant` are unchanged.
- **Terms:** staging's revision 1 in `docs/decisions/billing-terms.json` holds only the operator entry (300 credits, priceKey `morrow:operator_plan:beta`, no offer), pinned by `verify:billing`.
- **Staging tools:** `staging:seed-platform` writes the staging mark (before any terms insert). It refuses a database marked otherwise (`STAGING_SEED_DRIFT`, table `platform_environment`). New command `npm run staging:test-entitlement -- --workspace <id> --approval <staging-card-1.e13.YYYY-MM-DD.n> --record <docs/evidence/live/....md> --operator <id>`.
- **Api:** the billing period read (`billingPeriodLatest`) also reads an operator entitlement's snapshot period. M3's run admission keys its ledger on that period.

Non-goals: renewal (one 30-day period per workspace); any change to checkout, the receipt ingress, the broker or the Stripe switch; `TestEntitlementSeed`; production.

## Interfaces touched

`migrations/0034*`, `migrations/0035*` and the manifest; `docs/contracts/schemas/v1.1/billing.schema.json`, the regenerated bundle and the release baseline; `packages/work/src/billing/{terms,sql,facts}.ts`; `scripts/{staging,staging-runner,verify-billing}.mjs`; `docs/decisions/{billing-terms.json,data-lifecycle.md}`; `docs/decisions/approvals/{staging.md,staging-card.json}`; ADR-0022; the tenant-conformance registry.

## Security notes

- **Who can run it.** Only the administrator path, as `morrow_work_owner` under the D4 SET-row protocol. Every runtime login and role lacks EXECUTE. The function also refuses:
  - a current user other than the owner;
  - a Morrow login as session user;
  - any work session, lease or receipt context.
- **INVOKER, not SECURITY DEFINER.** The repository's operator idiom (0020, 0026, 0029) is INVOKER and granted to nobody, so the role check inside the function stays meaningful. A definer would act as the owner for any future EXECUTE grantee. (Kept on review; ADR-0022's amendment states it as an implementation note.) It reads the store associations through `morrow_identity.work_store_installations` as the owner, which 0034 allows: the owner inherits nothing from the command role, and a definer owned by the command role cannot be granted to the owner (the ownership transfer rewrites a grant to the old owner into the new owner's own). The owner is reached only by the administrator under D4 and already reads every billing row.
- **Staging only.** The function refuses unless the mark says `staging`. Further safeguards:
  - `terms_guard` refuses an operator entry unless the mark is `development` or `staging`;
  - production terms carry none (`verify:billing`);
  - a production reader refuses the test-mode route (R9).
- **The mark is enforced by the tooling, not the database.** A database cannot tell which environment it is; it keeps the first mark written, then makes it immutable. Only `staging:seed-platform` writes a mark, always `staging`, through the reviewed staging binding (the staging Neon project and branch). No production tool writes one.
- **Never a payment.** No receipt, verified payment event or `credit_grants` row is written; the operator key is not a payment, subscription or price key. The grant is recorded in its own table (kept on review; an implementation note in ADR-0022). The wallet is funded by the grant record alone, for its revision 2 and its exact units. After that, only sum-keeping moves are admitted.
- **Refusals.** Phase open only, like checkout and a verified payment's fix (P01.T04a R2, R3): the function refuses any workspace with a route, a store association (an installation that is or was linked), an account, a Stripe customer, a Stripe operation, a checkout or a receipt. A reused approval is `approval_conflict`; the same approval for the same workspace replays and writes nothing.
- **Linked stores.** After the grant the workspace can link a store. Until the owner's M6 ADR about testing on the live store exists, that store must be a Shopify development store, never the owner's live store (owner decision (a), quoted in ADR-0022's item 5 amendment and the E13 amendment).
  - *Enforced in code (M2 PR-2):* the broker's install stores nothing for a store whose `shop.plan.partnerDevelopment` is false (`store_not_development`, at install and every re-authorisation); 0026's `link_workspace_store` refuses a Shopify candidate whose installation is not a development store (`installation_ineligible`); 0026's app registry admits only development and staging. The live store can be neither installed nor linked. Checked at install, re-authorisation and link time, not while linked; no end date.
  - *Procedure:* choosing a fresh development store with test products only (the flag cannot tell one holding data copied from the live store), each registration and install under its own approval, and noticing a linked store that leaves development. This PR changes none of it.
- **Before any database effect, the CLI needs:**
  - the active card carrying E13;
  - an approval reference of that card and effect, dated from the amendment to today;
  - `main` verified (clean tree, `HEAD` at a freshly fetched `origin/main`, `foundation` green);
  - the record committed at that commit, read as its blob (`git ls-tree` then `git cat-file blob`), never from the working tree: one regular file at exactly that path, naming exactly the reference and the workspace on its `Approval reference:` and `Workspace:` lines, once each (a substring or a prefix such as `.1` inside `.10` does not count).

## Owner steps for the first use (each per action)

1. Merge (after PR #37).
2. `staging:migrate` (E3), applying 0034 and 0035.
3. `staging:seed-platform` (E3), which writes the staging mark and terms revision 1.
4. The owner's approval in chat for the named workspace.
5. Commit the live record `docs/evidence/live/YYYY-MM-DD-neon-test-entitlement-<slug>.md` to `main`, with the lines `` - Approval reference: `staging-card-1.e13.YYYY-MM-DD.n` `` and `` - Workspace: `<workspace id>` ``.
6. `npm run staging:test-entitlement -- ...` (E13).
7. Complete the record with the printed outcome.

## Test checklist

- [x] Unit (`tests/staging-runner.test.mjs`):
  - the closed input and result;
  - the D4 statements;
  - commits only on `granted` or `replayed`; every other outcome, or a malformed result, commits nothing;
  - the card, E13 and approval-date rules;
  - the CLI refuses before any SQL without the card, E13, the record, or a record naming exactly the approval and workspace, and on an unmerged HEAD (where it does not look the record up);
  - the record is read at the verified commit, not the working tree: a correct uncommitted file refuses, a committed record that does not name the run refuses although the working-tree file does, and a symbolic link, an executable or a directory at the path refuses (`committedRecord`);
  - the record's two labelled lines: exact values once each; a prefix (`.1` against `.10`, either way), a longer workspace id, a bare substring, a malformed value, a missing or repeated label all refuse;
  - the CLI's closed output;
  - the seed's staging mark (inserted, present, drift).
- [x] Unit (`tests/billing-operator-entitlement.test.mjs`):
  - the contract variants and the key;
  - the terms entry and its exclusions;
  - the facts reader;
  - billable on staging, `mode_refused` in production, `entitlement_stale` after 30 days.
- [x] Lab `lab:test-entitlement` (pg-http, PostgreSQL 17, CREATEROLE administrator; 20 checks):
  - refused without the staging mark and in a database marked development; the operator terms entry refused under a production mark, and a priced revision without an offer refused;
  - the seed's mark is written once, idempotent and immutable;
  - every runtime login and role refused, as are the superuser without the owner role and a session context;
  - a Stripe customer, a Stripe-fixed route, a receipt and a missing route row refused, as are forged operator keys;
  - a linked store (an association) refused as `route_conflict`; an installation never linked is not one; the work owner reads the associations through the bridge, the runtime logins and the api role cannot;
  - the grant writes route, account, wallet, snapshot and grant record in one commit;
  - no receipt, payment event or payment credit grant is written;
  - replay writes nothing; a reused approval conflicts;
  - the wallet sum equals the grant, and only moves keep it;
  - the route then admits linking (`link_route_current`);
  - the real billing handler on staging reads the plan, credits and period and offers no purchase; production reads `not_billable`.
- [x] `lab:tenant-conformance` (the two tables and the function registered; the work owner's one identity bridge, `workOwnerBridges`), `verify:billing` (staging's pinned terms), `contracts:generate` clean.
- [ ] Tier 2 AI review (separate context, same model family) with the security lens.
- [ ] Hosted CI on the PR head.
- [ ] (Owner, after merge) The first use, as above, with its live record.
