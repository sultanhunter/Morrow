# 2026-10-19 GitHub: Actions budget raised from $0 to $10

- **Approval.** Owner, in chat on 2026-10-19: "pro is active you set the action budget". This follows the OQ-2 answer "GitHub Pro (Recommended)", which included an Actions limit of about $10.
- **Exact action.**
  - In the attached browser, Settings → Billing → Budgets and alerts, Claude edited the existing account-scoped **Actions** budget (id `2852042c-86d3-4a21-8c2c-ca41fd06d2ae`) from $0.00 to **$10.00**.
  - "Stop usage when budget limit is reached" and the 75%/90%/100% email alerts stayed on.
  - A first attempt to create a second budget was refused by GitHub ("A budget for this product and scope already exists"), so no duplicate exists.
- **Observed state.**
  - Budget list: Actions $0.00 / $10.00, 0%, no longer "Usage blocked".
  - The account's base plan still reads **GitHub Free**; Pro is NOT active at the time of this record.
  - The other default $0 budgets (Codespaces, Packages, Git LFS, Copilot) and the $20 AI-credits budget are unchanged.
- **Cap.** $10 per month on Actions, with a hard stop.
- **Observed cost.** $0 so far.
- **Cleanup.** Set the budget back to $0 to block paid Actions usage again.
- **Unknown outcomes.** None.
