# ADR-0014 Merge authority and main as the trunk

- Status: Accepted
- Date: 2026-10-17
- Amends:
  - ADR-0002 "Flow", which had PRs target `codex/morrow-foundation` until the owner approved the first merge into `main`.
  - The plan's Package 3 rule that enforced repository protection must exist before merging release code.
- Amended: item 4, 2026-10-19 (P03.T04f OQ-1). See Amendments.
- Amended: item 5, 2026-10-19 (ADR-0019), with a third-party GitHub access exception the same day. See Amendments.
- Amended: item 1 and CI runners, 2026-10-22 (`ci.yml` on a self-hosted runner on the owner's Mac). See Amendments.

## Context

The overhaul (PR #2) passed hosted CI. Claude Code's permission check then blocked Claude from merging it as a "merge without review", because no record gave Claude merge authority. The owner then authorized merges explicitly.

## Decision

1. **Who merges.** Claude merges its own pull requests once both of these hold:
   - the hosted `foundation` check is green on the exact head;
   - the Tier 2 AI review (separate context, same model family) has passed, with its findings resolved or recorded.
2. **Trunk.** On 2026-10-17 the integration branch `codex/morrow-foundation` was merged into `main` through PR #1 (merge `f9ab367`).
   - Claude chose a merge commit, which keeps the reviewed history, over the squash merge that earlier drafts proposed. The owner's approval did not choose a merge strategy.
   - From now on `main` is the trunk. Each packet uses a short-lived `claude/<task-id>-<slug>` branch and a PR into `main`.
3. **Rules that still hold**, carried over from ADR-0002 "Flow":
   - Changes reach `main` only by merging a pull request. Nothing is pushed directly to `main`.
   - No force-push.
   - No tag deletion (this includes `codex-archive-f89ad75`) and no branch deletion without owner approval.
4. **Additional rules:**
   - No merge with a failing, cancelled or skipped required check. The `foundation` aggregator treats a skipped job as a failure (docs/development/ci.md).
   - No merge while a high-severity review finding is unresolved.
5. **Branch protection.** Enforced protection on `main` requires the `foundation` check and does not require an approving review, so a single GitHub account cannot deadlock. It must exist before privileged deployment (the first hosted deploy). It needs GitHub Pro or an organization on GitHub Team, which is a pending owner decision. Until then, the rules in items 3 and 4 are the protection.

## Consequences

- Routine merges do not wait on the owner. Material changes still need an owner-approved ADR before implementation (ADR-0002).
- GitHub records these merges under the owner's account, because Claude acts with the owner's token. Each PR Claude merges therefore states that Claude merged it under ADR-0014. Such a merge is not a Tier 3 owner approval.
- Deployment workflows can later run from `main`.

## Approval

Owner approval, 2026-10-17, in chat: "yes you are allowed to merge all the prs as you are the owner of the all the code being written".

## Amendments

### 2026-10-19: item 4, light CI runs (P03.T04f OQ-1)

The first bullet of item 4 now reads:

> No merge with a failing, cancelled or skipped required check. The `foundation` aggregator fails on any failed or cancelled job, and on any skipped job except the lab jobs that its `scope` job skips on a light run: a pull request whose changed files are all Markdown, or a push to `main` whose merged tree equals the merged pull request head (docs/development/ci.md).

The second bullet of item 4 is unchanged. The proposal and the alternatives are in `docs/packets/P03.T04f.md`, OQ-1.

Owner approval, 2026-10-19, in chat, answering P03.T04f OQ-1: "Allow both (Recommended)". That is option (a): both light paths, a Markdown-only pull request and a push to `main` whose merged tree equals the merged pull request head, with the amendment text above.

### 2026-10-19: item 5, branch protection before production (ADR-0019)

> Amendment 2026-10-19 (ADR-0019; owner decision, 2026-10-19, in chat). Item 5 now reads: "Enforced protection on `main` requires the `foundation` check and no approving review. It must exist before the first production deployment, production credential or production resource. It needs GitHub Pro or Team, a purchase the owner approves per action. Staging deploys do not wait for it." Until protection exists, items 3 and 4 are rules, not controls. An account that can push to `main` can change `deploy-staging.yml`, `ci.yml` or `scripts/staging.mjs` in the same push. It therefore controls the staging deploy token, which can deploy a broker that reads every staging broker secret. This is accepted for staging only, which holds synthetic data and the owner's test identity. Mitigations: only the owner's account can push, and every other app, token, deploy key and collaborator is removed before the first deploy. If GitHub Pro is bought, protection is enabled at once.

Owner approval, 2026-10-19, in chat. The staging plan, which made branch protection (Pro) a hard gate before production and not before staging, was approved with "yes this plan looks good" (ADR-0019, Approval). Asked directly "Earlier we agreed (ADR-0014) to turn on GitHub branch protection (GitHub Pro, about $4/month) before the first hosted deploy. With no users and only test data, should that wait until real production?", the owner answered "Required before production (Recommended)". ADR-0019, which carries this amendment, was approved with "Approve both (Recommended)". On P04.T01i OQ-2 the owner chose "GitHub Pro (Recommended)", so protection is enabled as soon as the Pro purchase is active. Pro became active and protection was enabled on 2026-10-19 (`docs/evidence/live/2026-10-19-github-pro-and-branch-protection.md`).

### 2026-10-19: item 5 exception, third-party GitHub access (ADR-0019)

The mitigation "every other app, token, deploy key and collaborator is removed before the first deploy" carries the exception recorded in ADR-0019's Amendments, for staging only:
- The third-party platform GitHub Apps AWS Connector, Codemagic, DigitalOcean, Expo, Netlify, Render and Vercel keep their access (an accepted MVP risk).
- Before the first staging deploy, the ChatGPT Codex Connector GitHub App is suspended and the classic token "AppForge Github Actions" (`repo` and `workflow`, no expiry) is deleted. The owner performs both, because GitHub's sudo re-authentication stopped Claude's attempt to suspend the app.

Owner decision, 2026-10-19, in chat: "Suspend Codex + revoke old token (Recommended)" (the question and option are quoted in ADR-0019, Amendments).

### 2026-10-22: `ci.yml` on a self-hosted runner on the owner's Mac

The GitHub-hosted Actions minutes for October were used up, and they reset on 1 November. Until then the `foundation` check could not run, so nothing could merge.

Owner decision, 2026-10-22, in chat: "for CI lets use our mac".

1. **Location.** The runner runs in Docker Desktop on the owner's Mac (Apple silicon). It is the container `morrow-mac-1`, with an optional second runner `morrow-mac-2`, and each runner has its own privileged Docker-in-Docker daemon (`infra/ci-runner/compose.yaml`). The owner starts, pauses and removes it with `npm run ci:runner`, or Claude runs it with the owner's per-action go-ahead (`docs/development/ci.md`, "Self-hosted runner on the owner's Mac").
2. **Only `ci.yml` on `main` targets it,** and only while the repository variable `MORROW_CI_RUNS_ON` is set. Deleting the variable returns every `ci.yml` job to `ubuntu-24.04` with no repository change. `deploy-staging.yml`, `heavy-faults.yml` and `frozen-regressions.yml` stay on GitHub-hosted runners. `tests/ci-workflow.test.mjs` pins all of this on `main`. That is configuration, not a control: GitHub cannot restrict a repository runner to one workflow, so while the runner is online any workflow in any branch can name its labels and run on it, with or without the variable (risk (a)). `pause` and `down` therefore also take the runner offline.
3. **No GitHub secret is sent to it.** `ci.yml` names no secret and no environment, and its token has `contents: read` only. The registration token is used once by the owner's script, reaches the one-off registration container only on stdin, and is never stored or printed. That does not keep the Mac's own files out of reach. The runner holds its own registration key, which any job can read (risk (c)). Local files that Docker Desktop shares are readable and writable by any job through (b); under Docker Desktop's default File sharing they include `~/.config/morrow`.
4. **Deploys stay hosted or local.** `deploy-staging.yml` is unchanged and stays on GitHub-hosted runners. Until the minutes reset, staging deploys run locally with the staging CLI under `staging-card-1`.
5. **Item 1.** While the variable is set, the `foundation` check reported from the Mac counts as "the hosted `foundation` check" of item 1. It is the same workflow and the same required check, run on another machine. A pull request merged on such a run says so.
6. **Narrowed File sharing before `up`.** Before the first `up`, the owner narrows Docker Desktop's File sharing (Settings, Resources, File sharing). No shared folder may be or contain the home folder or `/Volumes`. None may be, contain or lie inside the checkout, `/tmp` or `/var/folders`. None may lie inside `~/Library` or a dot entry of the home folder. Morrow's local labs bind-mount no host folder, so they need no share. `up` reads Docker Desktop's settings file and refuses with `CI_RUNNER_HOST_SHARE_TOO_BROAD` otherwise, including when Docker Desktop still shares its defaults.
7. **No fork pull request workflows.** Workflows from fork pull requests stay disabled for this repository: today `run_workflows_from_fork_pull_requests` is false. `up` refuses with `CI_RUNNER_FORK_PR_WORKFLOWS_ON` otherwise.

Residual risks, accepted while the runner is registered:
- (a) Anyone, and any GitHub App, with write access to the repository can run code on the Mac, inside the runner container, by pushing a branch. This includes a branch that adds its own workflow naming the runner's labels, which runs whether or not the variable is set for as long as the runner is online. Recommendation: remove write access from the third-party GitHub Apps that keep it under the item 5 exception (AWS Connector, Codemagic, DigitalOcean, Expo, Netlify, Render and Vercel).
- (b) The inner daemon is privileged. Any job can use it to start a privileged container, take root in Docker Desktop's Linux VM, and mount every host folder that Docker Desktop shares. It can then read and write those folders with the owner's permissions. Under Docker Desktop's defaults (`/Users`, `/Volumes`, `/private`, `/tmp`, `/var/folders`), that includes `~/.config/morrow` (the staging credentials), `~/.ssh`, and files that run code as the owner, such as shell startup files, `~/Library/LaunchAgents` and a checkout's git hooks. Item 6 removes those defaults. Whatever stays shared stays readable and writable by any job, so share nothing that the owner or an agent later runs or keeps secret. Root in the VM also reaches whatever else Docker Desktop exposes to its VM. Like any container, a job can also reach the Mac's own network services and the local network. The stronger alternative is a dedicated Linux VM with no host mounts, for example Lima or colima with mounts disabled. It is not adopted, because it needs new software on the Mac.
- (c) CI results now depend on the Mac's integrity. A compromised Mac, or a job that tampers with the long-lived runner, its daemon or its `docker`, `work` and `registration` volumes, can change the results of later runs. The runner's registration key is a credential that any job can read. With it, someone can run a listener as `morrow-mac-1` elsewhere. That listener receives later `ci.yml` jobs with their `contents: read` token and can report `foundation` results, and it keeps working after that person's write access is removed. Restarts, `up` and `pause` keep the key and every volume. Only `down` deletes the runner from GitHub, which revokes the key, and removes the volumes. After removing anyone's write access (the recommendation in (a)), or on any suspicion, run `down` and then `up`. The stronger alternative is a just-in-time ephemeral runner, which gets a new key for every job. It is not adopted, because a process holding a GitHub credential on the Mac would then have to create a registration for every job.
- (d) Timing checks may flake when the Mac is loaded. Rerun once before debugging.

Owner decisions on the residual risks, 2026-10-22, in chat:
- On (a): "for the mac ci lets run it as the third party apps doesn't matter as we are not executing anything elsewhere". The seven third-party GitHub Apps keep their access, and risk (a) is accepted as written.
- On item 6, asked whether to narrow File sharing first or run with the defaults: "I'll narrow file sharing first (Recommended)". The owner then narrowed it. Docker Desktop's settings record an empty share list. A probe container's bind mount of the checkout was refused ("mounts denied: The path … is not shared from the host").
- The same day, Claude ran `npm run ci:runner -- up` with the owner's go-ahead ("done"). That registered `morrow-mac-1` and set `MORROW_CI_RUNS_ON`. The registration token reached only the one-off registration container's stdin.

Switching back: on 1 November, run `npm run ci:runner -- down`. `pause` deletes the variable and stops the runners, but it keeps the registration key and volumes until `down`, so use it only for a short break.
