# ADR-0036: model defaults and the AI cost cap

- Status: brief, 2026-10-25. Branch `claude/adr-0036-model-defaults-cost-cap`, from `main` at `500e87dc`. Decision: ADR-0036 (OD-2026-10-25-1, the owner in chat). Change class: material (money: defaults and a cost cap), recorded by the owner-approved ADR before this code.

## Goal

Carry out the owner's decision: Morrow, the main agent, defaults to Opus 5.5 at high; every other agent kind (specialists, sub-agents and every installed agent, Listings included) defaults to Opus 5.5 at medium; the US$4.50 unrecovered-cost cap is removed for Listings and loop runs. Keep the per-run US$7 and per-day US$25 backstops, holds and reservations, the three-failure breaker, the Anthropic monthly limit and every authority rule.

## Scope

- **Catalogue data** (`docs/decisions/model-policy.json`): per-product version 3 published (version 1's entries, credits, rates and caps; default Opus 5.5 at medium; default member ceiling 4; no unrecovered-cost cap; digest pinned), version 1 retired with its published US$4.50 kept and enforced nowhere; the proposed loop version 2's installed default becomes Opus 5.5 at medium and its cap is removed (its other values stay proposed). Generated `model-catalogue.ts` and `loop-catalogue.ts` regenerated; neither carries a cap field.
- **Migration 0047** (`model-defaults-cost-cap`, work owner, the next free number on `main`; renumber at integration, since the loop branch also uses 0047): seeds version 3 (versions, entries, rates) exactly as generated; retires version 1 inside a single `DISABLE`/`ENABLE TRIGGER append_only` pair; makes the cap column nullable with `CHECK ((cap IS NOT NULL)=(version=1))`; revises `morrow_billing.unrecovered_allows` from its md5-pinned 0033 body so it compares with no cap (false still for an unknown version, no period or a negative worst case). `run_reserve`, `run_product_begin` and `cmd_run_admit` are not redefined.
- **Code**: `unrecoveredAllows` removed from `@morrow/policy/run-credits`; `workspacePeriodUnrecoveredCostCapUsd8` removed from `CatalogueLimits`; the verify rules in `scripts/provider-checks.mjs` (ADR-0036 item 5); comments on the `unrecovered_cost_cap` codes kept for the closed sets; agent-platform fakes and the workspace-web fixtures (Team, agent pages, Add agents, "How this agent thinks", the Listings workspace default, a project member note).
- **Docs**: ADR-0036, OD-2026-10-25-1, the ADR index, short amendment notes in ADR-0022, 0023, 0026, 0027 and 0034, `budgets.md`, `work-api.md`, `model-selection.md`, the spine (§9), `mvp.md`, `v1-build-order.md` and `F-model-and-effort`. The M3 brief stays as history.

## Interfaces touched

`docs/decisions/model-policy.json`; `packages/policy/src/{model-catalogue,run-credits,agent-platform-fakes}.ts` and `generated/{model,loop}-catalogue.ts`; `packages/work/src/runs/{commands,http,workflow}.ts`, `packages/work/src/runtime/run-steps.ts` (comments); `packages/workspace-ui/src/copy.ts` (comment); `apps/workspace-web/src/fixtures/{adapter,seed,team,projects-data}.ts`; `scripts/{generate-model-catalogue,provider-checks}.mjs`; `migrations/0047.model-defaults-cost-cap.sql` and `manifest.json`; labs `run-credits`, `listings-runs`, `listings-authority`, `work-workers`. No contract schema, route, capability, grant or secret changes.

## Security notes

- Budget checks stay in code: the US$7 run limit, the US$25 daily cap, credit and vendor reservations, the breaker, `cost_overflow` and `reservation_exhausted` are untouched; only the period cap goes. AI cost that earns no credit is bounded by US$25 a workspace a day and the Anthropic Console monthly limit.
- A profile is never authority: no tool, capability, grant or scope changes with a default.
- The member ceiling follows the default (4 credits a product, the default's own credits); holders of `governance.model_default.revise` (`human_only`) still change it, and a workspace's stored ceiling and default are kept.
- Applied migrations are untouched; 0047 replaces 0033's helper only from its pinned body and lifts the append-only trigger for one status change inside its transaction.
- Deploy 0047 and the Workers together: between the two, Listings admission is refused `catalogue_inactive`, never admitted at the wrong version.

## Test checklist

- [x] `tests/model-defaults-cost-cap.test.mjs` (new): the verbatim quote in OD-2026-10-25-1, ADR-0036 and version 3; the defaults (Opus high for Morrow, Opus medium for every other kind and for Listings, ceiling 4); no cap in any generated catalogue and verify refusing one on any version but 1; the US$7, US$25 and breaker refusals (TypeScript twins, both run shapes); 0047's seed equal to the generated version 3; 0047's shape; `unrecovered_allows` revised from its pinned body with every other check kept, and its callers not redefined.
- [x] Updated pins: `model-catalogue`, `providers`, `loop-catalogue`, `run-credits`, `agent-package`, `tool-catalogue`, `listings-authority`, `workspace-web-{agents,runs,team}`, tenant-conformance probes.
- [x] `npm run graph -- check` (0 errors), `typecheck`, `typecheck:edge`, `edge:check`, `verify`, `format:check`, `npm test`.
- [ ] `lab:run-credits` (C4 no cap past US$4.50 while the run limit and the daily cap refuse; C6 on version 3 and 4; C12 the 0047 catalogue and its CHECK) and `lab:listings-runs` (M1 the default, U1 no cap), `lab:listings-authority` (M1, M4) and `lab:work-workers`: see the PR for the local runs; CI is the authority.
- [ ] Owner: confirm the default member ceiling of 4 (ADR-0036 Approval).

## The agent-loop branch (`claude/t4-agent-loop`, not merged): the same change

Line numbers are on `origin/claude/t4-agent-loop` at `2f2e8a9a`.

- `migrations/0047.agent-runs.sql`: line 213, `loop_catalogue_versions.workspace_period_unrecovered_cost_cap_usd` (drop the column; the migration is unapplied); lines 230-233, the version 2 row's digest `ffbbafa6…` becomes `fc519d878a45eedb3c5d31d6101b663c06d10b540550d5e500ba63ce11b6b648` and loses its 4.50; lines 1043-1063 in `cmd_agent_run_admit`, drop the `v_unrecovered` read and the `unrecovered_cost_cap` refusal (keep the daily backstop and its interlock), and line 949's `v_unrecovered` declaration; the header comment at lines 33-40 (line 39) and the outcome list at 925-938. Line 50's `unrecovered_costs` prerequisite may stay. It also takes the number 0047, which this branch uses: one of the two is renumbered. Neither migration's prerequisites read what the other changes, so either order applies.
- `packages/work/src/loop/admission.ts`: line 251, `unrecovered_cost_cap` in `admitRefusals`; `installedProfile` (line 192) follows the generated default and needs no edit.
- `tests/agent-loop-migrations.test.mjs`: lines 212-245, the version row drift check reads `workspacePeriodUnrecoveredCostCapUsd12`, which the generated catalogue no longer has; line 410, `'unrecovered_cost_cap'` in the definer's outcome list.
- `tests/agent-loop.test.mjs`: lines 201-205, the installed default pinned as Sonnet 5.5 at low; lines 218-241, the routed manifest built from `installedProfile(2)` pins `maxTurns` 16, `maxOutputTokensPerTurn` 5000 and `holdUsd` 3.36 (Opus 5.5 at medium: 12, 12000, 6.72).
- `scripts/agent-loop-lab.mjs`: line 14 (header); lines 898-903, A4 expects `unrecovered_cost_cap` for Opus high (that case goes: with no cap it is admitted, so A4 needs another refusal or none for it); lines 914-943, A5 raises and restores the cap column around the daily-backstop case (drop both `UPDATE`s; the three Opus high runs and the fourth's `daily_backstop` stand).
- `tests/fixtures/agent-loop-world.mjs`: line 48, `agentWorld`'s default arguments (Sonnet 5.5 at low) are a test sample, not the kind's default: no change needed.
- `docs/briefs/t4-agent-loop.md`: line 76, owner question 2 (the US$4.50 cap against loop holds) is answered by OD-2026-10-25-1; line 75's version 2 values stay open except the installed default.
- `tests/broker-agent-turn.test.mjs` uses Sonnet 5.5 at low as a sample entry (lines 135-190, 528-532, 759): no change needed unless it pins the kind's default.
- Integration with this branch: both rewrite the same lines of `tests/projects-migrations.test.mjs` (each lets only its own migration follow 0046), so the merge conflicts there; the resolution lets both follow, `/\.(agent-runs|model-defaults-cost-cap)\.sql$/`. Both edit `tests/tenant-conformance/probes.test.mjs` in separate hunks, and both add a 0047 row to `migrations/manifest.json`. The other open branches (`t10-e2b-adapter`, `t5-shop-knowledge`, `t7-sunrise-inbox`, `v1-connection-health`, `v1-undo-history-picker`) encode neither the defaults nor the cap; the picker's `catalog-undo-lab` selects Sonnet 5.5 at low explicitly (1 credit, still within version 3).
