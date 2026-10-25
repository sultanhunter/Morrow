# Morrow status

Updated 2026-10-24. Rewrite this file in place (at most 80 lines). The pre-overhaul checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`; the long per-PR notes of 2026-10-24 are `git show 57a68cd6:docs/progress/STATUS.md`. Then run `npm run graph -- status` (its "Last merged" stops at PR-45 until graph phase 1).

## Active work

**v1 is built live (ADR-0035):** the deployed `morrow-staging-*` Workers and Neon `morrow-staging` are v1 production, built and tested on the owner's own store through a custom-distribution app, under one standing approval with a one-line log (`docs/evidence/activity-log.md`). The build order (PRs 1–26) follows `docs/plan/mvp.md` tracks T1–T18.
- **Milestone 1 is merged and deployed**, with every switch that costs money or writes to the store committed off: connect the live store (#50, 0039–0040), Disconnect store (#53, 0041–0042), review, approve and apply (#54, 0044–0045, apply switch off), the computer foundation (#51, 0043, runtime switch off) and the agent-platform contracts (#52).
- **Sunrise workspace merged:** the shell and Home (#55), Team, agent pages, Add agents, Settings, Shop knowledge and Files (#56), the project screens (#57). Fixture-backed parts stay behind default-off switches.
- **Projects backend merged and live (PR 18, #58, `5541e430`):** measured goals, areas, Quick tasks and the plan start over ADR-0033/0034; migration 0046; switches off, start routes held. Its digests moved to Web Crypto (the api Worker cannot load `node:crypto`), pinned by vectors from the old code. AI review nits left for later: declare the four Promise-returning digest helpers `async`; `node:crypto` remains in `policy/src/index.ts`, `policy/src/review.ts` and `work/src/approvals/digests.ts`, outside the edge typecheck graph.
- **Next wave (building, six builders from `5541e430`, each AI-reviewed then opened as a PR):** the agent loop (PR 11, `claude/t4-agent-loop`), connect E2B (PR 8, `claude/t10-e2b-adapter`), Undo, apply history, approve several and the product picker (PR 4, `claude/v1-undo-history-picker`), store connection health (PR 5, `claude/v1-connection-health`), the Sunrise Inbox and activity log (PR 15, `claude/t7-sunrise-inbox`), shop knowledge and notebooks (PR 20, `claude/t5-shop-knowledge`). Their migrations start at 0047 and are renumbered at integration.

## Live environment

- Ledger 46 after `staging:migrate` of 0046 (`5541e430`); deploy flag on, so each green push to `main` deploys. A merge that carries migrations stops its deploy at gate 3 until `staging:migrate` (E3) runs; then rerun it.
- Self-service sign-up is on (`staging:seed-platform -- --self-service`, terms revision 1). Nobody has signed in yet.
- The model provider is committed on (model-provider-on, owner's Anthropic limit US$100 as stated); it is live once Claude places the key with `staging:put-secret` and reruns the deploy held at gate 6.
- Switches committed off: Shopify apply, the agent loop, plan drafts, specialists, the runtime (no E2B key placed), Stripe.
- Shopify: the live-store app exists in the owner's Dev Dashboard organization; its settings file lives outside the repository. Its first version is not released yet (the CLI's device login expired), so it is not installed or registered.
- E2B: project `Morrow-staging`, US$20 usage limit and US$5 alert; no key, sandbox or template.

## Last green commit

`5541e430` on `main` (#58): `foundation` push run 40082222885; `Deploy staging` run 40083171135 (rerun after the gate-3 hold). Before it `57a68cd6` (#57): run 40079878230, deploy 40080094004.

## Next actions

1. The next build wave: review, CI and merge each PR in turn; `staging:migrate` and the held deploy after any merge with migrations.
2. Connect the owner's store (with the owner, `docs/briefs/v1-connect-store.md`): the owner signs in and sends the workspace id; Claude reruns `shopify app deploy` for the device login while the owner is at the screen; custom distribution to the owner's store; the owner seals the client secret; `staging:shopify-app-register` and `staging:test-entitlement`; the owner installs and presses "Link store".
3. Turn Claude on: model-provider-on has merged with the switch on; Claude runs `npm run staging:put-secret -- ANTHROPIC_API_KEY` from `origin/main` (the owner's key file is placed) and reruns the deploy held at gate 6. Then the first drafts, review and, after the owner's yes, the apply switch.
4. Then: Ask Morrow with per-agent model and effort (PR 12), computer tools (PR 13), proactive work (PR 21), check E2B and switch it on (PR 9), credits for the owner's workspace (PR 6), the other launch agents (PRs 22–26).
5. Carried: the gate-3 polling fix; graph phase 1; a KEK fingerprint check in `staging:put-secret`; `providers.json`'s Shopify and E2B rows.

## Blockers

None for building. Live use waits on the owner's steps above. The catalogue version 2 values (limits and prices per model, ADR-0027) need the owner's yes before the agent loop's switch goes on.

## Pending owner actions

- Sign in at the api's workers.dev address and send the workspace id; be at the screen for the Shopify CLI login; seal the app's client secret.
- Place the E2B key with `morrow_put` (the Anthropic key is placed).
- New Cloudflare tokens before 2026-11-18.
- Old credential rotations: the Cloudflare Global API Key; a new WorkOS key that revokes the old ones; delete Neon project `cool-butterfly-64820147`; delete the local `cloudflare-ci-token` and `cloudflare-operator-token.old-*` files; `tmutil addexclusion ~/.config/morrow`.
- Housekeeping: mark the GitGuardian alert on `apps/shopify-connector/worker/database.ts` line 22 a false positive; keep or remove the public ChatGPT link in `docs/references/architecture.md` line 30.
- Before outside merchants (ADR-0035): Shopify Partner questions (G8), App Pricing, the public app and App Review, E2B's DPA (G16), entity, payout, tax, privacy policy and terms.

## Open unknown-outcome provider operations

None. The three Neon probe branches of 2026-10-20 carried expiries; their deletion is still not read back.

## Active approval cards

The owner's standing approval, ADR-0035 item 4 (`adr-0035`, approved 2026-10-23, no end date; `docs/decisions/standing-approval.json`, record `docs/evidence/live/2026-10-23-standing-approval.md`). The tools read it since #50; `staging-card.json` is kept as history. Staging card 2 is dropped.
