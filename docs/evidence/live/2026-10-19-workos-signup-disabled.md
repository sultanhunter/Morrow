# 2026-10-19 WorkOS: public sign-up turned off (staging environment)

- **Approval.** Owner, in chat on 2026-10-19: "6- you do it workos is also logged in attached browser" (P04.T01i D9 step 6(b)), with staging card `staging-card-1` approved the same day.
- **Exact action.** In the attached browser, environment `environment_01M4HG7FV7X8EFXE1J9S6GG00R`, Authentication → Features → Sign-up → Manage: Claude switched the toggle to off and chose Save changes. The card now reads "Disabled".
- **Email verification.**
  - WorkOS shows no separate toggle for this.
  - Emails → Configuration lists "Email verification: Enabled".
  - WorkOS documents verification as on by default and required for authentication unless configured otherwise.
  - Claude changed nothing on that page.
- **Not changed.** The Email + Password policy dialog was opened to look for the setting and closed with Cancel, without saving.
- **Cap and observed cost.** $0 (WorkOS free tier).
- **Cleanup.** Re-enable Sign-up only by an owner-approved revision (ADR-0009 items 10 and 11).
- **Unknown outcomes.** None.
- **Read-only inventory, same session.**
  - Users: one, the owner's `sultanibneusman0@gmail.com` (4 sign-ins, last on 2026-10-16).
  - No webhook endpoints.
  - One organization, WorkOS's "Test Organization" (example.com, Test Provider), created 2026-10-10.
  - The API Keys page was not opened (P04.T01i D9).
