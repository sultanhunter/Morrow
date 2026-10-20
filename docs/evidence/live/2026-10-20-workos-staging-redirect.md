# 2026-10-20 WorkOS: the staging callback is the only redirect

- **Approval.** Staging card `staging-card-1`, effect E6:
  - add exactly one redirect, `https://morrow-staging-api.sultanibneusman0.workers.dev/auth/workos/callback`;
  - remove the loopback `http://127.0.0.1:4110/…`;
  - in the attached browser, on the Redirects page only.
- **Exact action.** In the attached browser, environment `environment_01M4HG7FV7X8EFXE1J9S6GG00R` ("Staging"), Applications → Morrow Workspace (`client_01M4HG7GA0DX8C3PFSQHBP4BN3`) → Redirects → Redirect URIs. WorkOS now keeps redirects per application; the old environment Redirects URL redirects here.
  - Claude added the staging callback and set it as the default.
  - Claude removed `http://127.0.0.1:4110/operator/workos/callback` from the list.
  - Claude's click on Save changes was blocked by this session's permission classifier ("Account & Standing-Rule Changes"). The owner reviewed the open dialog and clicked **Save changes**, between 13:00Z and the 13:37Z read-back.
- **Read back.** The Redirects page lists exactly one Redirect URI, the staging callback. Initiate login, sign-out, invitation and password-reset URLs are "Not set".
- **Not opened.** The API keys tab. The Details tab, opened on the way, shows only a masked key suffix.
- **Cap and observed cost.** $0 (WorkOS free tier).
- **Cleanup.** None. Restoring the loopback is not planned (the local operator flow uses its own environment).
- **Unknown outcomes.** None.
