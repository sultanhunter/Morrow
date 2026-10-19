# 2026-10-19 GitHub: staging environment, branch policy and variables

- **Approval.** Owner, in chat on 2026-10-19: "7- you do it" (P04.T01i D9 step 7, OQ-2 answer A). Staging card `staging-card-1` was approved the same day.
- **Exact action.** Run by Claude with the owner's `gh` CLI login, about 11:41 UTC:
  - `PUT repos/sultanhunter/Morrow/environments/staging` with `deployment_branch_policy {protected_branches:false, custom_branch_policies:true}`.
  - `POST .../environments/staging/deployment-branch-policies` with `name=main` and `type=branch` (policy id 63568591).
  - `gh variable set CLOUDFLARE_ACCOUNT_ID --env staging` (account id; an identifier, not a secret).
  - `gh variable set STAGING_DEPLOY_ENABLED --env staging --body 0`.
- **Resources.** GitHub environment `staging` on `sultanhunter/Morrow`, its one branch policy and its two variables.
- **Plan at the time.** The account was still on GitHub Free: the environment and its branch policy were created on Free, and before the Pro purchase, although D9 step 7 says "Option A, after the purchase". GitHub accepted both calls. The licensing page first read Pro at about 18:45 IST (13:15 UTC); see 2026-10-19-github-pro-and-branch-protection.md.
- **Not done.** The `CLOUDFLARE_API_TOKEN` environment secret is not set; it waits for the owner-created CI token. Branch protection on `main` failed at this time with HTTP 403 "Upgrade to GitHub Pro"; it was enabled after Pro became active (same record).
- **Cap and observed cost.** $0.
- **Cleanup.** Delete the environment (`gh api -X DELETE repos/sultanhunter/Morrow/environments/staging`) if staging is retired.
- **Unknown outcomes.** None. Each call's response was read back.
- **Read-back on Pro** (read-only `GET` calls with the owner's `gh` login, 2026-10-19 15:15 UTC): environment `staging`, created and last updated 11:41:51 UTC, with protection rule `branch_policy` and `deployment_branch_policy {protected_branches:false, custom_branch_policies:true}`; one branch policy, `main` (id 63568591, type `branch`), in force; variables `CLOUDFLARE_ACCOUNT_ID` and `STAGING_DEPLOY_ENABLED`; zero environment secrets.
- **Read-only inventory, same session.**
  - Collaborators: the owner only. No pending invitations, deploy keys, webhooks or repository secrets.
  - The ChatGPT Codex Connector GitHub App is installed with read and write access to all repositories. The owner later chose to have it suspended, with the "AppForge Github Actions" token deleted, before the first deploy (ADR-0019 item 5 exception; 2026-10-19-owner-decisions-provider-cleanup.md).
