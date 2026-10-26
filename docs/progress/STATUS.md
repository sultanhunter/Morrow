# Morrow status

Updated 2026-10-26. Rewrite this file in place (at most 80 lines). The 2026-10-24 version is `git show 5541e430:docs/progress/STATUS.md`. Then run `npm run graph -- status`.

## Active work

**v1 is built live (ADR-0035)** on the deployed `morrow-staging-*` Workers and Neon `morrow-staging`, on the owner's own store.
- **Live and working:** sign-in; the owner's store installed and linked, with its shop webhooks registered (#71); the connector's scheduled jobs in a Durable Object near the database (#74, ADR-0038); review, approve and apply (apply switch off); Undo, history and the product picker (#67); the Sunrise Inbox (#65); shop knowledge (#68); connection health (#66, clean-up switch off); renewal of the test credits (#80). Claude is on (#73, #77): Opus 5.5 defaults (#70, ADR-0036), and the owner's identity-backed Anthropic key is placed and scoped to the Morrow workspace.
- **Decisions on main:**
  - ADR-0037: Morrow orchestrates scoped teammates; one agent kind.
  - ADR-0039: credits are the only spend limit. OD-2026-10-26-1 and -2: failed runs are free; the final-turn reserve; the platform ceiling; an optional per-agent limit; which endings are free; a breaker after 3 failed runs.
  - ADR-0038: a Durable Object for the connector cron.
- **Architecture before the agent loop (PR #82, Proposed):**
  - ADR-0040: messaging with agents, Dots-style. Write first, reply fast, work in the background, deliver complete results.
  - ADR-0041: state-of-the-art harness foundations (own harness on the Messages API; Opus 5.5 only; no small turn, time or context caps; compaction and context management; long-horizon runs; memory layers including per-person memory; orchestration).
  - The owner's direction is production grade with no MVP shortcuts in the foundation. 35 owner questions are on `Q-adr-0040-0041-owner-questions` and on the shared page "Harness Foundations".
- **Held until #82 is approved:** #64 (agent loop; its migration must move after 0055) and #79 (teammate contracts, catalogue version 4; its merge resolution needs a separate review). Both are rebuilt to ADR-0041.
- **#83 (Opus-only credits catalogue, ADR-0039 PR 1):** reviewed. It waits for the owner's question 1 (does low effort stay?). Before merge, renumber 0055 to the next free number, fix A1 (the migration's "after 0052" line), take A2 (the loop catalogue's Opus-only rule) or leave it to #64, and check its failed job.

## Live environment

- Ledger 55 (0053–0054 connection health, 0055 test-credit renewal). The deploy flag is on. A merge with migrations stops at gate 3 until `staging:migrate` runs; then rerun the deploy.
- Switches committed off: Shopify apply, the agent loop, plan drafts, specialists, the runtime (no E2B key), Stripe, connection clean-up.
- Test credits: 300 for 30 days from 2026-10-24. `staging:test-credits -- renew` renews per period (#80).

## Last green commit

`43cc5489` on `main` (#80): `foundation` run 40292261540; `Deploy staging` run 40292979102, rerun after the gate-3 hold, health ready. Before it, `c41b79ee` (#66): run 40282219470, deploy 40282609164.

## Next actions

1. On the owner's answers to the 35 questions: merge #82, then rebuild #64 and #79 to ADR-0041 (the implementation plan is `docs/plan/harness-foundations-implementation.md` on #82), then #83.
2. With the owner: the first Listings drafts on the live store, then a log check end to end.
3. CI: give each test a time limit in `scripts/run-tests.mjs`, so a hang fails with its name instead of cancelling `checks` at 15 minutes (seen on #68 and #75).
4. Follow-ups: the Inbox wording for scope changes (#66 review L1); an operator path to lift a system scope stop; worktree clean-up, including the stale `claude/adr-0041-harness-foundations` branch from a stopped workflow.

## Blockers

The agent loop, teammate calls and the messaging work wait on the owner's answers on #82. Nothing else blocks building.

## Pending owner actions

- Answer the 35 architecture questions ("recommended" or by number).
- Try the first Listings drafts and say when, so Claude can check the logs.
- In the Anthropic Console: delete or disable the first, now unused key. Check the new key's expiry (Never, or 90+ days). Delete `~/.config/morrow/staging/anthropic-api-key.old-*`.
- The E2B key and template build, before the computer tools switch on.
- New Cloudflare tokens before 2026-11-18. The OK on invisible Turnstile. WorkOS sign-in branding.
- Carried from 2026-10-24: old credential rotations and housekeeping; the list before outside merchants (ADR-0035).

## Open unknown-outcome provider operations

None. The deletion of the three Neon probe branches of 2026-10-20 is still not read back.

## Active approval cards

The owner's standing approval, ADR-0035 item 4 (`adr-0035`, approved 2026-10-23, no end date; `docs/decisions/standing-approval.json`).
