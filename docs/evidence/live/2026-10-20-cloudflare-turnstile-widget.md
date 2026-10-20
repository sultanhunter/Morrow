# 2026-10-20 Cloudflare: Turnstile widget `morrow-staging` created

- **Approval.** Staging card `staging-card-1`, effect E5: create the Turnstile widget `morrow-staging` (invisible, one hostname) through the API.
- **Exact action.** `npm run staging:turnstile-create` from `claude/p04-t01i-d1-identifiers`, with the operator token (read by the tool, never printed).
  - **12:53:09Z, refused.** `STAGING_TURNSTILE_CREATE_FAILED`. The tool's widget list showed no widget, and no secret file remained.
  - **12:53:47Z, refused again.** This run used the tool change that reports Cloudflare's status and numeric codes: 403, code 10000. Again no widget and no file.
  - Cause: the operator token had Turnstile Read, not Edit. The owner changed it to Edit (`2026-10-20-cloudflare-census-and-queues.md`).
  - **13:37:39Z to 13:37:46Z, created.** Widget `morrow-staging`:
    - mode `invisible`;
    - one domain, `morrow-staging-api.sultanibneusman0.workers.dev`;
    - site key `0x4AAAAAAFdwF1eDox4vfBd2`, which is public and goes into `LOGIN_CHALLENGE_JSON` in PR-D part 1.
- **Secret.** The tool wrote the widget secret straight to the owner file `~/.config/morrow/staging/turnstile-secret` (mode 600, non-empty) and recorded the rotation time. The secret was never printed or logged, and Claude never read it.
- **Cap and observed cost.** Turnstile is free. Cost: $0.
- **Cleanup.** The widget stays for staging. Rotate its secret with `staging:turnstile-rotate` (E5).
- **Unknown outcomes.** None. Each refused attempt was checked against the widget list (no widget), and the create returned the site key and secret.
