# 2026-10-19 GitHub: Actions budget raised from $0 to $10

- **Approval.** Owner, in chat on 2026-10-19 at 11:40 UTC (17:10 IST), in the message that also answered D9 steps 2–7: "pro is active you set the action budget". This follows the OQ-2 answer "GitHub Pro (Recommended)", which included an Actions limit of about $10.
- **Exact action.** About 11:47–11:48 UTC (17:17–17:18 IST), from the session transcript.
  - In the attached browser, Settings → Billing → Budgets and alerts, Claude edited the existing account-scoped **Actions** budget (id `2852042c-86d3-4a21-8c2c-ca41fd06d2ae`) from $0.00 to **$10.00**.
  - "Stop usage when budget limit is reached" and the 75%/90%/100% email alerts stayed on.
  - A first attempt to create a second budget was refused by GitHub ("A budget for this product and scope already exists"), so no duplicate exists.
- **Observed state.**
  - Budget list: Actions $0.00 / $10.00, 0%, no longer "Usage blocked".
  - The account's base plan still read **GitHub Free** at the time of the edit, although the owner's message said Pro was active. The account also read Free at 17:20 IST (2026-10-19-owner-decisions-provider-cleanup.md). The licensing page first read **GitHub Pro** at about 18:45 IST (2026-10-19-github-pro-and-branch-protection.md). The $10 budget therefore first applied on Free, and Pro was in place by about 18:45 IST.
  - The other default $0 budgets (Codespaces, Packages, Git LFS, Copilot) and the $20 AI-credits budget are unchanged.
- **Cap.** $10 per month on Actions, with a hard stop.
- **Observed cost.** $0 so far.
- **Cleanup.** Set the budget back to $0 to block paid Actions usage again.
- **Unknown outcomes.** None.
