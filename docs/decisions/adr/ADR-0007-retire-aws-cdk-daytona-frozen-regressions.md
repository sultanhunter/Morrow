# ADR-0007 Retire the AWS CDK foundation, the Daytona laboratory and the frozen WorkOS operator regressions

- Status: Accepted
- Date: 2026-10-17
- Supersedes two build-plan instructions:
  - "Keep AWS templates and observations as explicitly superseded historical evidence" (Recommended engineering defaults);
  - "P04.T01f remains a historical Daytona lab, with cleanup retained for any original operation" (P04.T01).

## Context

On 14 October 2026 the owner selected Cloudflare, Neon, E2B and WorkOS. The earlier AWS candidate (CDK, Aurora, Fargate, Temporal) was never deployed, and Daytona was replaced before any key or sandbox existed. The tree still carried three kinds of code for them.

- **AWS CDK.** The CDK foundation in `packages/infrastructure/src/{index,service-identities,environments,readiness}.ts`, plus `aws-cdk-lib` 2.272.0 and `constructs`. The `deps:repair` step patched a bundled `brace-expansion` inside `node_modules` before every `npm run ci`. Three orphan scripts remained (the CDK synth, the AWS readiness check and the IAM permission matrix), and `scripts/cost-estimate.mjs` still carried the AWS warm-cost estimate. The live operational event encoder and the operations lab imported the CDK modules, so two SQL labs loaded `aws-cdk-lib` at runtime.
- **Daytona.** The Daytona container laboratory had three scripts, a TypeScript core, three tests, a profile and account observation, a provider record and two `daytona-selection-54` archives. It depended on `@daytona/sdk`.
- **Frozen regressions.** Five frozen checked-copy regressions (71, 74, 75, 80 and 82) re-ran archived WorkOS operator sources. They also pinned the SHA of `package-lock.json`, so any dependency change failed them.

Of the 575 lockfile entries, 181 were reachable only through `aws-cdk-lib` or `@daytona/sdk`. Those entries included all 20 bundled (`inBundle`) packages.

Code that might still be needed to reconcile an unknown provider operation must not be deleted. The evidence below was checked first.

## Evidence that no provider operation is still open

Every path below can be read with `git show codex-archive-f89ad75:<path>`.

- **Daytona** never created an API key, a sandbox or a provider call:
  - `docs/decisions/morrow-provider-lab.json` (still in the tree) records `api_key_created: false` and `sandbox_created: false`;
  - `docs/evidence/P04.T01f/{preparation,live,archive,cleanup}.json` all record `provider_calls: false`;
  - `infra/labs/daytona-development-account.json` records `container_creation_enabled: false` and `operator_access_authorized: false`.
- **E2B:**
  - The only owned build was reconciled read-only to `ready_retained`, with a saved terminal receipt. That is operation `c423fb7d-6935-4917-8862-0b4bbf5a2961`, template `pdht65h2trfuizuvmotc`, build `4324bde3-d3a9-4d18-91c1-b2b1b3e80b80`, recorded in `docs/evidence/P04.T01h/owned-build-reconciliation.json`.
  - The sandbox from run 66 is `verified_deleted`, with a saved terminal receipt (`runtime-terminal-66.json`).
  - The three runs from 67 are each `verified_deleted`, with saved terminal receipts and `held_slot: false` (`diagnostic-run-67-{1,2,3}.json`).
  - The E2B code stays in the tree. `infra/labs/e2b-activation.json` denies its allocation, build, image and template paths; original-operation cleanup and read-only reconciliation remain available.
- **WorkOS:**
  - 71: the exact new staging session was revoked, and a fresh dashboard read showed no remaining active test-user sessions (`docs/evidence/P05.T01e/actual-workos-71.json`).
  - 74: the new session was revoked, and no controlled sessions remained active (`docs/evidence/P05.T01g/actual-workos-74.json`). The immutable journal's `unknown` cleanup field is superseded by that read-back.
  - 75: one read-only GET returned `not_observed_active`, and the allowance was consumed (`docs/evidence/P05.T01h/actual-workos-75.json`).
  - 80: the trial was held. It made no native session-catalogue request and produced no attributable new session. A fresh dashboard read showed zero active sessions (`docs/evidence/P05.T01l/actual-staging-trial.json`).
  - 82: the exact verified session was revoked, and a fresh dashboard read showed zero active sessions (`docs/evidence/P05.T01n/actual-staging-trial.json`). The native `unknown` cleanup field is superseded by that manually verified revocation.
  - Every allowance is consumed, and the in-tree native operators 74, 75 and 82 are denied by explicit gates.

Some provider state is left over, but every outcome is known, so none of it is an unknown operation. The owner can remove each item in the provider console; `docs/progress/STATUS.md` lists them: the retained E2B template and build, the E2B qualification key, the WorkOS staging test user and the loopback callback.

## Decision

1. **Delete the AWS CDK foundation and its tooling.** This covers:
   - the four CDK modules;
   - the `./legacy-aws` export;
   - `aws-cdk-lib` and `constructs`;
   - `scripts/{repair-cdk-bundle,infrastructure,infrastructure-readiness,service-permissions}.mjs`;
   - `infra/dependency-repair.json`, `infra/requirements-validation.txt` and `infra/providers/temporal.json`;
   - the AWS warm-cost estimate and its tests;
   - the CDK tests.

   What replaces them:
   - `packages/infrastructure/src/operations.ts` keeps its environment and service enumerations as local constants with the same values.
   - `scripts/operations-lab.mjs` keeps activation held by compiling the reviewed selected development configuration. It throws `INVALID_ACTIVATION_NOT_HELD` unless `owner_cost_authorization` is `null` and both dispatch switches are `disabled`.
2. **Delete the Daytona laboratory:** its scripts, core, tests, profiles, provider record, both `daytona-selection-54` archives and `@daytona/sdk`. Some Daytona references stay on purpose:
   - The import-boundary rules and fixtures keep `daytona` as a synthetic SDK family.
   - `scripts/stack-cost.mjs` and `scripts/verify-providers.mjs` still reject Daytona meters and records.
3. **Delete the five frozen regressions:** their runners, their unit tests and their npm scripts. These stay:
   - the in-tree native operators 74, 75 and 82;
   - those operators' controller, transport, listener, journal, native and CLI unit tests.
4. **Regenerate the lockfile** without `aws-cdk-lib`, `constructs`, `@daytona/sdk` and the root `brace-expansion` pin.
   - The change only removes entries, and no bundled entries remain.
   - `brace-expansion` still resolves to 5.0.12 through `e2b`, `glob` and `minimatch`.
   - The `sharp` and `miniflare` > `undici` overrides stay.
   - `lockedBundleAncestor` stays in `scripts/delivery-checks.mjs`, and its test moves to `tests/delivery.test.mjs`.
5. **Delete `docs/plan/source.json`.** It was the snapshot manifest of the retired Page, and nothing reads it now.
6. **Edit the build plan.** It no longer says to keep AWS templates or Daytona cleanup.

## Consequences

- `npm run ci` no longer modifies `node_modules`, and a dependency change no longer fails a frozen toolchain pin.
- The removed code can be replayed from the tag if needed. Check the tag out into its own worktree, never into this checkout:
  1. `git worktree add ../morrow-f89ad75 codex-archive-f89ad75`
  2. `npm ci --ignore-scripts`
  3. Run one of its scripts, for example `npm run lab:workos-operator-frozen74` or `npm run lab:daytona-development`.

  These replays use their original sources and lockfile. Their native provider paths were already denied at that commit.
- Reintroducing AWS, Daytona or a frozen regression needs a new ADR.

## Approval

The owner approved this on 2026-10-17 by selecting **"Approve full overhaul (Recommended)"** (recorded in ADR-0001). The scope of that overhaul (P03.T04c) includes retiring AWS CDK, Daytona and the frozen regressions.
