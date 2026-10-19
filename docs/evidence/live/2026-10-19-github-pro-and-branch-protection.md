# 2026-10-19 GitHub: Pro active and branch protection on main

- **Approval.**
  - The owner bought GitHub Pro themselves ("I'll finish it myself"). The licensing page read "Current GitHub base plan: GitHub Pro, $4 per month" at about 18:45 IST.
  - Branch protection: asked "Turn on branch protection for `main` now? It requires the CI `foundation` check to pass, applies to admins too, needs no approving review, and blocks force-pushes and branch deletion.", the owner answered "Turn it on (Recommended)". This is ADR-0014 item 5 as amended by ADR-0019.
- **Exact action.** Claude ran, with the owner's `gh` login: `PUT repos/sultanhunter/Morrow/branches/main/protection` with:
  - `required_status_checks {strict:false, checks:[{context:"foundation", app_id:15368}]}`;
  - `enforce_admins:true`;
  - `required_pull_request_reviews:null`;
  - `restrictions:null`;
  - `allow_force_pushes:false` and `allow_deletions:false`.
- **Read-back.** The response shows checks `foundation` (GitHub Actions, app 15368), enforce_admins true, no review requirement, force pushes false and deletions false.
- **Cap and observed cost.** GitHub Pro is $4 a month (owner purchase). The Actions budget is $10 with a hard stop; see 2026-10-19-github-actions-budget.md.
- **Cleanup.** To remove protection: `gh api -X DELETE repos/sultanhunter/Morrow/branches/main/protection` (owner decision).
- **Unknown outcomes.** None.
