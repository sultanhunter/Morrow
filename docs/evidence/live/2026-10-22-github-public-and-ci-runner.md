# 2026-10-22 GitHub: the Mac CI runner registered and removed, and the repository made public

The GitHub-hosted Actions minutes for October were used up, so the `foundation` check could not run. The owner first chose a self-hosted runner on the Mac, then a public repository on GitHub-hosted runners. ADR-0014's 2026-10-22 amendment holds the runner's rules and residual risks; this record holds the effects. Exact times were not recorded unless given.

- **Approval.** The owner wrote in chat on 2026-10-22 (ADR-0023, Approval):
  - Q1: "yes to all recommended, for CI lets use our mac".
  - On Docker Desktop's File sharing, asked whether to narrow it first or run with the defaults: "I'll narrow file sharing first (Recommended)" (ADR-0014 amendment).
  - Q6, on residual risk (a): "for the mac ci lets run it as the third party apps doesn't matter as we are not executing anything elsewhere, delted the e2b key".
  - The go-ahead for `up`: "done" (ADR-0014 amendment).
  - Q7: "okay then i think its better that we make the repo public and use github runners".
  - Q8, after the read-only pre-publication sweep: "its fine not a blocker, anyhing else that is sensitive?".
  - Q9: "no need for new sweep i am going to make the repo public now".
- **Owner action: Docker Desktop File sharing.** Before `up`, the owner narrowed Settings → Resources → File sharing. Docker Desktop's settings then recorded an empty share list, and a probe container's bind mount of the checkout was refused ("mounts denied: The path … is not shared from the host"). The setting stays as the owner left it; Claude did not change it. Morrow's local labs bind-mount no host folder, so they need no share.
- **Exact action: runner up.** Claude ran `npm run ci:runner -- up`. It registered the repository runner `morrow-mac-1` (Docker Desktop on the Mac) and set the repository variable `MORROW_CI_RUNS_ON`, so `ci.yml` jobs on `main` targeted the runner. The one-time registration token reached only the one-off registration container's standard input and was never stored or printed. Which jobs ran on the runner is in each run's job metadata; this record does not list them.
- **Pre-publication sweep.** Read-only, over every branch, tag and past commit (508 commits, 6,557 files). It found no secrets: every credential-shaped value is a labelled test fake. It listed personal data in old history, which the owner accepted (Q8, Q9).
- **Exact action: runner down.** Before the repository went public, Claude ran `npm run ci:runner -- down`: it deleted the variable `MORROW_CI_RUNS_ON`, deleted the runner registration (which revokes the runner's key), and removed the runner stack and its volumes. `ci.yml` jobs returned to GitHub-hosted `ubuntu-24.04` runners with no repository change.
- **Owner action: repository public.** The owner changed the repository's visibility to public. CI on GitHub-hosted runners is free for a public repository. PR #38 (`ea69518`, merged 16:47Z) landed the runner tooling with ADR-0014 item 8: `up` refuses with `CI_RUNNER_REPOSITORY_PUBLIC` unless the repository is private.
- **Owner action: fork pull request workflows.** The owner set Settings → Actions → General → "Require approval for all outside collaborators" (it had been "first-time contributors only").
- **Read-back.** Every later `foundation` run on `main` ran on GitHub-hosted runners, the first being push run 39840134758 on `7484df2` (19:26Z). Claude did not re-read the visibility or the fork setting for this record; both are the owner's report.
- **Secrets.** None in this record, and none passed through Claude. The runner's registration key was revoked by `down`.
- **Cap and observed cost.** US$0. The US$10 Actions budget with its hard stop is unchanged (`2026-10-19-github-actions-budget.md`).
- **Cleanup.** Done by `down`: no runner, no variable, no stack or volumes remain. The `infra/ci-runner` tooling stays in the tree until the ADR-0023 cleanup PR.
- **Unknown outcomes.** None.
