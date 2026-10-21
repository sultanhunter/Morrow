# 2026-10-20 Owner: preconditions for the first staging deploy

- **Source.** Owner, in chat, 2026-10-20. Asked about the remaining preconditions in `staging-card-1` ("Preconditions for the first deploy"), the owner answered: "app suspended,token deleted and use the fallback".
- **GitHub.** The owner suspended the ChatGPT Codex Connector GitHub App and deleted the classic token "AppForge Github Actions". Claude cannot verify either: GitHub's API does not expose them to Claude's token. ADR-0019 item 5 exception: the platform GitHub Apps stay.
- **Cloudflare usage alerts.** The owner chose the D6 fallback: the existing $5 billable-usage alert plus the owner's weekly check of Billing → Usage.
- **Also done by the owner on 2026-10-20 (records elsewhere).**
  - Cloudflare operator token: Pages Read, Turnstile Edit and Workers Observability Read (`2026-10-20-cloudflare-census-and-queues.md`).
  - Neon `morrow` database and `staging` branch (`2026-10-20-neon-staging-branch.md`).
  - The vault KEK file `vault-kek-v1`. Mode 600 checked by metadata only; the key was never read.
- **Acknowledgement requested.**
  - Claude asked the owner to acknowledge two actions beyond the cards' literal wording: opening the WorkOS Applications list and Details tab during E6, and the refused R2 bucket list during the E9 permission probe.
  - The owner replied "done" to the message that listed this item with the other remaining steps. There was no separate wording for it.
