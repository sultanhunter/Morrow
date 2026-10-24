# 2026-10-23 The owner's standing approval (ADR-0035 item 4) as the tools' approval record

- **Approval.** The owner wrote in chat on 2026-10-23, after reading ADR-0035's summary and the CLAUDE.md change: "approve ADR-0035 and the CLAUDE.md change" (OD-2026-10-23-10). ADR-0035 item 4 is the standing approval; it replaced `staging-card-1` on acceptance.
- **Standing approval:** `adr-0035`
- **What the tools read.** `docs/decisions/standing-approval.json` (v1 PR 1), with no end date. The owner ends it by setting its `status` to `withdrawn`, or by a later decision. `staging-card.json` stays as history and is no longer read.
- **What it covers (item 4).** Build-and-operate actions in the one environment (the `morrow-staging-*` Workers and the Neon project `morrow-staging`, branch `staging`): deploys, migrations, provider setup, sign-in and test runs, live evals and reads of the owner's store through Morrow, within the owner's spend caps. For the tools this means:
  - every `staging:*` command that checked the card;
  - self-service sign-up for the owner's own login (`seed-platform -- --self-service`), on the WorkOS facts recorded in `2026-10-19-workos-signup-disabled.md` (public sign-up off, email verification on), re-read before the first run;
  - the test entitlement for the owner's workspace only (the workspace the live-store app invites), 300 test credits for 30 days, with a reference `adr-0035.e13.<date>.<n>`; this record is its evidence.
- **Still asked every time (item 4).** Purchases, plan upgrades and ad spend; raising a cap (more than 300 credits in 30 days is one); deleting data; sending anything to the owner's customers; the App Store submission; any store other than the owner's.
- **Log.** Each action under it is one line in `docs/evidence/activity-log.md`. This record and that log never name the shop's domain, a customer, a product or a secret.
- **Exact action.** None: this records the approval the tools read.
- **Cap and observed cost.** US$0.
- **Unknown outcomes.** None.
