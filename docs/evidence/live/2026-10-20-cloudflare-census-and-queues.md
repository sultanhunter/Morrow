# 2026-10-20 Cloudflare: census passes, staging queues created

- **Approval.** Staging card `staging-card-1`: effect E9 for the census and permission probes (read-only), effect E4 for the two queues. The card was approved 2026-10-19 and is valid until 2026-11-18.
- **Owner changes to the operator token `morrow-staging-operator`**, made by the owner in Safari:
  - **Cloudflare Pages · Read** added after the census was refused with 403, code 10000.
  - **Turnstile** changed from Read to **Edit**, and **Workers Observability · Read** added, after the Turnstile create was refused (`2026-10-20-cloudflare-turnstile-widget.md`).
  - The token value did not change. Claude never saw it.
- **Census.** `npm run staging:census` was run from `claude/p04-t01i-d1-identifiers`:
  - Before Pages Read (three runs, the last near 12:45Z): 403, code 10000, on the Pages list. The dispatch-namespace list returns 403, code 10121 (no Workers for Platforms); the tool now counts that as zero namespaces.
  - After Pages Read, 12:52Z: exit 0 with `{"scripts":[],"pages":[],"dispatchNamespaces":0,"members":1,"findings":[]}`.
- **Permission probe.** After the Turnstile refusal (shortly after 12:54Z), and again at 13:37Z after the owner's edit, read-only calls with the operator token printed HTTP status and Cloudflare numeric codes only:
  - **200:** Workers scripts, Queues, Turnstile list, Pages, members, Workflows; after the edit, also Workers Observability keys.
  - **403, code 10000:** Workers Observability keys (before the edit) and R2 buckets. R2 is not in the packet's permission list.
- **Queues (E4).** `npm run staging:queues`, 12:52:56Z to 12:53:04Z, exit 0. Created `morrow-staging-dispatch-dlq` and `morrow-staging-dispatch`.
- **Cap and observed cost.** Workers Paid includes 1M queue operations a month; expected and observed use is 0 (no producer or consumer is deployed). Cost: $0.
- **Cleanup.** The queues stay for staging. Delete them only with the staging environment.
- **Unknown outcomes.** None. Both creates returned success.
