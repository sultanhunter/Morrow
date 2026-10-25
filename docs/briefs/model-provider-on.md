# Turn the model provider on (Claude, the owner's key)

- Status: built, 2026-10-25. Branch `claude/model-provider-on`, one PR. The v1 build order's step 2 (ADR-0035 item 8.2): the model goes on with the owner's Anthropic key, after "Disconnect store" (#53, `ed5c70e5`; M3 owner decision 14).
- Change class: material, already owner-approved. ADR-0022 items 7, 10 and 11 chose the provider, the broker custody and the caps in code. ADR-0035 items 4 and 8.2 approved turning it on, standing. No new decision is taken here. The Tier 2 review uses the security lens (credentials, provider effects, spend).
- The owner's facts (chat, 2026-10-25): the key is saved as `~/.config/morrow/staging/anthropic-api-key`. The Console workspace `Morrow` has a monthly spend limit, in the owner's words "Anthropic limit 100$". Claude did not read the file or open the Console.

## Goal

The owner's own Listings request in the workspace reaches Claude through the one gateway. It stays within the owner's US$100 Console limit and the caps in code: US$7 a run and US$25 a workspace a day (ADR-0022 item 11). Every other switch stays off: the agent loop, plan drafts, specialists, Shopify apply (writes), the runtime and Stripe.

## Scope

- **The record.** `docs/decisions/model-provider-staging.json` changes to:
  - `switch` `"on"`;
  - `monthly_spend_limit_usd` `"100.00"`, as a decimal string like the runtime record's;
  - `observed_on` `"2026-10-25"`.

  Its scope quotes the owner's words. It notes that the prerequisite is met on main (#53). It notes that ADR-0035 item 4's standing approval supersedes the old per-action approval of the first call. The record rule (`reviewedModelRecord`) is unchanged: "on" still needs a limit and its date.
- **Vars and the secret.**
  - `MORROW_MODEL_PROVIDER: "anthropic"` goes into `env.staging.vars` of the api, the broker and the orchestrator.
  - The orchestrator also gets `MORROW_DATABASE_BINDING_JSON`, byte-equal to the api's.
  - `ANTHROPIC_API_KEY` goes into the broker's `env.staging` `secrets.required`, making 15 names.
  - The Worker types are regenerated (`edge:types`).
  - Development and production are unchanged. They carry no switch.
- **Key placement.** `npm run staging:put-secret -- ANTHROPIC_API_KEY` has the same safeguards as every other name:
  - the standing approval;
  - the reviewed-main preconditions: a clean tree, HEAD equal to a freshly fetched `origin/main`, and a green `foundation` on it;
  - the owner file `anthropic-api-key`, which must be 0600, owner-only and a regular file in the format `sk-ant-api03-` plus 80–200 characters. The format is drift-tested against the broker's own `anthropicKeyPattern`.

  The value goes only to `wrangler secret bulk` stdin. The command prints the name and the broker version id only: no value, length or fingerprint, as for every other name.

  While the switch is off it refuses with `STAGING_MODEL_OFF` before it reads the file or runs any tool. No flag places the key ahead of the switch.

  The same constants drive the other tools:
  - `secrets-status` requires the name and the file while the switch is on;
  - `provision-roles --first` reads the file into the first-deploy file, as it does the Stripe files.
- **Gate 6's next step.** When every name the deployed broker lacks is one `put-secret` places, and the broker holds no stray name, `STAGING_BROKER_SECRETS_MISMATCH` also reports two things:
  - `missing`: the committed names, never a value;
  - `next: "run_staging_put_secret_then_gh_run_rerun"`, like gate 3's `next` for migrations.

  Anything else stops as before, with no next step.

Non-goals: any model call or eval run by Claude, the activity-log lines (the lead writes them for the real placement and deploy), and every other switch.

## The order, and why

The choice is option (a), the Stripe switch's protocol: one PR, merge, `put-secret` from main, then rerun the held deploy.

- **(a) is the smallest safe design.** It is one PR, with no new flag and no new optional-secret path. Gate 6 is used as it stands, with the same merge-then-rerun shape as gate 3.
- **Its only cost** is that the merge commit's `Deploy staging` run is red at gate 6, with nothing uploaded, until the rerun.
- **Option (b) is larger.** Placing the key while the switch is off would need a `--while-model-off` flag on main before the key could be placed from reviewed main. That is a tooling PR, then the switch PR, plus a second optional name in gate 6 and `secrets-status`. It buys nothing here: the owner's key is already saved.

**The deploy never runs with the switch on and no key.** Three layers stop it:

1. **Gate 6** (`scripts/staging-deploy.mjs`). It holds the deployed broker's secret names to `brokerRequiredSecretsFor("staging", stripe, "on", runtime)` exactly. Without the key it stops before the census and before any upload. Staging keeps running the previous version, in which the switch is off.
2. **Cloudflare.**
   - Wrangler 4.116 uploads `secrets.required` as inherit bindings, and Cloudflare refuses an upload whose inherited secret is missing ("The following required secrets have not been set"). So even a hand-run deploy of the committed broker cannot go live without the key.
   - The deploy tool reconciles that failed upload as `not_deployed`. It stops before the orchestrator, the connector and the api.
3. **The broker itself** (`apps/broker/src/capabilities.ts`, `model()`).
   - With `MORROW_MODEL_PROVIDER` set but no well-formed key, the model capability is null. `modelRespond` answers `BROKER_HELD` (`MODEL_UNAVAILABLE`) before any input, database or provider access.
   - The Listings run ends `failed` (`provider_error`, reason `broker_held`) with no provider request, and the stale close books its reservation.
   - The broker's other capabilities and its health are unchanged (`tests/broker.test.mjs`, `tests/broker-model.test.mjs`).

**Between `put-secret` and the rerun,** the running broker holds a key it never reads: its version has no `MORROW_MODEL_PROVIDER`. **During the rerun** the broker deploys first. So the broker that reads the key is live before the orchestrator dispatches and before the api admits runs.

## Operator runbook

1. **Merge** once `foundation` is green on the exact head and the Tier 2 AI review has passed.
2. **The merge commit's `Deploy staging` run stops at gate 6.** It reports `"code":"STAGING_BROKER_SECRETS_MISMATCH"`, `"missing":["ANTHROPIC_API_KEY"]` and `"next":"run_staging_put_secret_then_gh_run_rerun"`, with nothing uploaded. This PR has no migration, so gate 3 passes first.
3. **Place the key from reviewed main.** Use a clean checkout at `origin/main` (the merge commit, with `foundation` green) and run `npm run staging:put-secret -- ANTHROPIC_API_KEY`. Expect `{"command":"put-secret","secret":"ANTHROPIC_API_KEY","versionId":"<uuid>"}`.
4. **Rerun the held deploy:** `gh run rerun <run id> --repo sultanhunter/Morrow`.
   - If `main` has moved on, rerun the newest main commit's held run instead; the older one reports `superseded`.
   - From a local checkout at `origin/main`, `npm run staging:deploy` also works.
   - The run passes gate 6 and deploys the broker, the orchestrator, the connector and the api, then runs the health check and the unattended smoke.
5. **Smoke.**
   - `npm run staging:secrets-status`: the broker holds its 15 names, with no mismatch, and `anthropic-api-key` is ok.
   - In Workers Logs for `morrow-staging-broker`, the `morrow_broker_init` health line shows `"model":true,"modelMode":"anthropic"`. The line carries no value.
   - Signed in, the workspace's `GET …/models` reports `draftingAvailable: true`.
6. **The first model call is the owner's own Listings request** in the workspace, under ADR-0035 item 4 and within the caps above. Drafts stay inside Morrow. The apply switch is still off.
7. **Log.** The lead writes one line in `docs/evidence/activity-log.md` for each of the placement and the deploy: the date, the action, the result and the cost.

**Turning it off again** follows gate 6's order, like Stripe's:

1. **The reverse commit.** Set `switch` to `"off"`; the limit and its date may stay. Remove the three vars, the orchestrator's binding and the `secrets.required` name.
2. **Merge.** Its deploy stops at gate 6: the broker still holds the key, a stray name, so no next step is named.
3. **Remove the key.** This deletes data, so Claude asks the owner first. The command is `npx --no-install wrangler secret delete ANTHROPIC_API_KEY --config apps/broker/wrangler.jsonc --env staging`.
4. **Rerun the held deploy.**

For an immediate stop, use "Stop AI work", the platform stop or the kill switch, which need no commit. Revoking the key in the Console is the owner's.

## Interfaces touched

- `docs/decisions/model-provider-staging.json`.
- `apps/{api,broker,workers}/wrangler.jsonc` and their `worker-configuration.d.ts`.
- `scripts/staging.mjs`: `identityConstants`, `put-secret`, `provision-roles --first` and the deploy plan.
- `scripts/staging-files.mjs`: `anthropicKeyFormat` and the `anthropic-api-key` spec.
- `scripts/staging-deploy.mjs`: gate 6's `missing` and `next`.
- Tests: `edge-config`, `staging-secrets`, `staging-deploy`, `broker`, `api-environment` and the staging fakes.
- `infra/rotation-runbook.md`.

No migration, contract, route, binding kind, provider resource or Worker code changes. The api, broker and orchestrator code already reads the switch.

## Security notes

- **Custody.** The key is the broker's alone. `edge:check` refuses `ANTHROPIC_*` on any other Worker (`EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER`), and the orchestrator's mapper refuses any credential-like name. The value travels only owner file → process → `secret bulk` stdin; it never appears on a command line, in output, in a report or in the repository. The tests plant markers and check every stream, argv and report.
- **Mixed states.** `edge:check` refuses any mixed state (`EDGE_MODEL_SWITCH_MIXED` with `EDGE_VARS` or `EDGE_BROKER_SECRETS`):
  - a missing var on the api, the broker or the orchestrator;
  - the orchestrator's binding missing or not byte-equal to the api's;
  - the key missing from `secrets.required`;
  - any model name in development, in production or on the connector;
  - a production or invalid record, which counts as off.
- **Spend.** The checks are in code, outside prompts: the per-run and per-workspace-day caps, reservations, the fence and the stops. The Console limit is the provider-side ceiling. No model call is made by this PR or its tests.

## Test checklist

- [x] `tests/edge-config.test.mjs`:
  - the committed record is on with the owner's limit, and the record rule (on without a limit or date, production, malformed);
  - the committed blocks verify on;
  - every mixed state on: a missing var per Worker, no key in `secrets.required`, the binding not the api's, the key on another Worker, development, production;
  - the reverse commit's off state, and mixed states while off;
  - every other switch is off.
- [x] `tests/staging-secrets.test.mjs`:
  - `put-secret ANTHROPIC_API_KEY`: refused while off before any call; on, by stdin after the main preconditions, and only the name printed; no flag places it; malformed, missing and 0644 files are refused by name;
  - `provision-roles --first` with the switch on;
  - the record via `stagingModelSwitch`;
  - the format drift against `anthropicKeyPattern`;
  - `secrets-status` while on (15 names, file required, key missing) and while off (the key as an extra name);
  - no marker reaches any output.
- [x] `tests/staging-deploy.test.mjs`: gate 6 holds the on deploy, local and CI, before the census and any upload, with `missing` and `next`. The deploy passes once the key is placed, broker first. A role password missing, a stray name, or the key while off gets no next step.
- [x] `tests/broker.test.mjs`: the committed staging broker vars carry the switch; without the key the model capability is null while health holds; a well-formed key gives the capability. `tests/api-environment.test.mjs`: the committed staging api maps `model: "anthropic"`.
- [ ] Local results: see below.
- [ ] Hosted `foundation` on the PR head; Tier 2 AI review (separate context, same model family) with the security lens.

## Remaining gates

- The owner's own Listings request is the first live call.
- M3 owner decision 37's measured output-token floor (128,000 an hour assumed) is measured by the first runs, not before. Medium and high effort per model follow from the owner's own use.
- The activity-log lines for the placement and the deploy are the lead's.
