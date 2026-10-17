# Morrow: working rules

Morrow is a paid AI workspace where a Shopify brand's people and AI agents run the business together. It has one standalone web workspace and a thin Shopify connector. The Coordinator scopes work, specialist agents draft, people approve exact proposals, and one gateway executes, reads back and audits.

## Read at the start of every session
1. `docs/progress/STATUS.md`: active packet, last green commit, next action, blockers, pending owner actions.
2. The active packet in `docs/packets/` (when there is one), and the plan sections it cites.
3. `docs/plan/build-plan.md` is the **plan of record** (ADR-0001). Decisions live in `docs/decisions/adr/`. `docs/references/*` is supporting detail; where it conflicts with the plan, the plan wins.
4. `git status` and `git log -5`. Pre-R1 history (evidence, archived plans, the old Page sequences) is in tag `codex-archive-f89ad75`. Recover a file with `git show codex-archive-f89ad75:<path>`.

## Settled product constraints (owner-decided; change only by an owner-approved ADR)
- Name: Morrow.
- Broad production foundation for small and large Shopify brands. No MVP scope reduction of the launch destination.
- Visual option 1.
- One complete standalone Morrow workspace plus a thin Shopify read/write connector: install, link, status, reconnect, disconnect, return. No embedded domain workspace in this release.
- Paid managed model APIs and one work-credit balance. No free merchant tier.
- Coordinator is separate from the optional Chief of Staff and CMO installations. Agent titles and delegation never confer authority.
- Stack: TypeScript/React; Cloudflare Workers, Workflows, Queues and R2; Neon PostgreSQL; E2B isolated execution; WorkOS identity. Morrow owns all authorization.
- All 18 packages, 80 parent task IDs and 73 acceptance IDs stay. Lettered children are allowed.

## Security invariants (never weaken; each one has owning tests)
- Tenant data is isolated with FORCE RLS and restricted roles. Never accept client-supplied tenant or workspace identifiers as authority.
- An agent's effective authority is the intersection of: the requester's grants, the installation's grants, the delegation envelope, connector scopes, live policy, and the installation owner's current authority.
- Approvals are bound to a digest of the exact proposal. Any edit invalidates them. The gateway re-checks authority before execution.
- Permission and budget checks happen in code, outside model prompts.
- Unknown provider or commit outcomes are reconciled before any retry. Never promote an unknown outcome to success.
- Raw provider, merchant and model credentials are readable only by the broker Worker. Never place secrets in the repo, in chat or in logs.
- Default entry denies. Real routes fail closed without qualified configuration.
- Kill switches are `human_only` and need no second approver. Agents may only propose them (ADR-0005).
- No agent-initiated external effect before the P11 gateway, budget reservations and stop controls exist.
- No real merchant data of a given class before its P09.T05 deletion and privacy path exists. Never use the owner's live shop for development.
- Applied migrations are immutable. Change the schema only with new forward migrations.

## Change classification (ADR-0002)
- **Material** changes need an owner-approved ADR before dependent code. Material means:
  - scope, the package/task structure, the authority model, tenancy, retention or public contracts;
  - provider or model selection, billing, pricing or credits;
  - gates or dependency edges, deployment boundaries;
  - spending money, real merchant data, external messages, or creating provider resources.
- **Routine** changes are plain commits with tests: fixes, refactors, CI and harness work, lettered packet splits, wording.
- Hardening budget: at most two consecutive lettered children on one subsystem without an observable product delta, unless an ADR names the threat being retired.

## Provider and live effects
- Every provider resource creation, deployment, migration on a hosted database, sign-in test, paid action or merchant-data access needs owner approval first. Approval is per action, until a standing staging approval card is approved and recorded in `docs/decisions/approvals/`.
- Production, real merchant or customer data, customer messages, ad spend, publication, app-review submissions, purchases and plan upgrades always need per-action approval.
- The owner places credentials with `wrangler secret put`, `gh secret set`, interactive logins (suggest `! <command>`), or chmod-600 files under `~/.config/morrow/<env>/`. Never ask for keys in chat. Never read credential files into context.
- Record each live effect in `docs/evidence/live/YYYY-MM-DD-<provider>-<action>.md`: approval, exact action, resources, cap and observed cost, cleanup, and unknown-outcome status.
- Do not read or copy anything from the old Codex working directory (`~/Documents/Codex/.../work/morrow-private-staging`). Its credentials must be rotated.

## Engineering
- Node 24.13.0 (`.nvmrc`; Homebrew `node@24` works). Run `npm ci --ignore-scripts` with the pinned lockfile.
- Local pipeline: `npm run ci` (format, typecheck, verify, unit tests, build, offline lab and infrastructure checks) plus `npm run smoke:scaffold`. `npm run verify` includes `plan:check` on `docs/plan/build-plan.md`.
- Labs run real workerd and PostgreSQL 17. They are grouped the way CI runs them: `npm run lab:workspace-api-workers`, `lab:group:workers`, `lab:group:pg-core`, `lab:group:pg-linking`, `lab:group:pg-http`. The PostgreSQL groups need Docker running. `lab:group:pgwire` runs only on Linux CI. A heavily loaded Mac can trip timing checks, so rerun once before you debug. CI is the authority. `docs/development/ci.md` describes the jobs.
- Generated contracts and validators: `npm run contracts:generate`. Never add runtime eval or runtime schema compilation.
- Tests and labs write outputs to `.artifacts/` (git-ignored). `npm run ci` must leave the tree clean.
- Keep the existing idiom: strict TypeScript, closed primitive inputs at trust boundaries, fixed parameterized SQL, no caller-supplied SQL, roles or options.

## Delivery flow
- One short-lived branch (`claude/<task-id>-<slug>`) and one PR per bounded packet.
- PRs target the integration branch `codex/morrow-foundation` until the owner approves the first merge into `main`. Merge on green CI.
- Never push to `main`, force-push, or delete tags or branches without owner approval.
- Each PR changes observable behaviour or retires a named risk, and carries its tests.
- Review tiers:
  - Tier 1: your own targeted tests plus the full pipeline.
  - Tier 2: a separate-context AI review (`/code-review`, plus `/security-review` for authority, RLS, migrations, credentials, provider adapters, approvals, budgets, billing or durable execution). Label it "AI review (separate context, same model family)", never independent.
  - Tier 3: the owner.
- Definition of done: tests pass in CI, the acceptance table in `docs/acceptance/PNN.md` is updated, STATUS.md is updated, and remaining gates are stated plainly. Structural checks and AI review never make a task Verified when a human or hosted gate is still open.

## Status
Rewrite `docs/progress/STATUS.md` (at most 80 lines) before ending a session. It records: active packet, last green commit with its CI run, next action, blockers, pending owner actions, open unknown-outcome provider operations, and active approval cards.
