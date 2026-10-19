# 2026-10-19 Owner answers on provider clean-up (no provider effect)

Owner answers in chat on 2026-10-19 (times are IST, from the session transcript):
- **GitHub Pro.** "I'll finish it myself". The account still read GitHub Free at 17:20 IST, so branch protection waits for the owner's purchase.
- **ChatGPT Codex Connector** (GitHub App with read and write access to all repositories).
  - First answer (about 18:29 IST): "i am not working with codex so it won't push anything so leave it". The previous agent's task is stated stopped.
  - That answer conflicted with ADR-0019 item 5 and the ADR-0014 item 5 amendment, which require every other GitHub App, token, deploy key and collaborator to be removed before the **first staging deploy**, not before production. An earlier version of this record said "revisit before production", which misstated the amendment.
  - **Superseded the same day (about 20:39 IST).** Asked again with the risk stated plainly (the question is quoted in ADR-0019, Amendments), the owner answered "Suspend Codex + revoke old token (Recommended)":
    - the Codex app is suspended (reversible);
    - the classic token "AppForge Github Actions" (`repo` and `workflow`, no expiry; GitHub showed "Last used within the last 10 months") is deleted;
    - the platform GitHub Apps AWS Connector, Codemagic, DigitalOcean, Expo, Netlify, Render and Vercel stay, as an accepted exception for staging (ADR-0019 item 5 exception, ADR-0014 item 5 amendment).
  - **No provider effect.** Claude's attempt to suspend the app in the attached browser stopped at GitHub's sudo re-authentication prompt (GitHub Mobile or an emailed code), and nothing changed. The owner performs both the suspension and the token deletion. Both are pending owner actions and a precondition for the first staging deploy (`staging-card-1`, "Preconditions for the first deploy").
- **Cloudflare account dedication (P04.T01i OQ-3).** "Use this account" (option C: accept, with the census at every deploy). See 2026-10-19-cloudflare-wrangler-revoke-and-alert.md.
- **Wrangler OAuth.** "Revoke it (Recommended)". Done; see the same record.
