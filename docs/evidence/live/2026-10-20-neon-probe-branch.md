# 2026-10-20 Neon: neon-probe created one expiring probe branch; the probe measured nothing

- **Approval.** Staging card `staging-card-1`, effect E3: throwaway probe branches with an expiry, in project `morrow-staging` only. The card was approved 2026-10-19 and is valid until 2026-11-18.
- **Exact action.**
  - At 2026-10-20T02:22:13Z Claude ran `npm run staging:neon-probe` from the identifiers branch.
  - It used the project-scoped API key, read by the tool and never printed.
  - It created branch `morrow-probe-8c3e0d96` (`br-spring-boat-b71bm6dq`), a child of the root `br-noisy-wind-b7cxr2a1`, created 02:22:21Z, `expires_at` 04:22:17Z, `--no-secrets`.
- **Unknown outcome, reconciled.** The tool exited with code 13 (unsettled top-level await) before printing a result. A read-only branch list at 02:22:33Z (Neon API, HTTP 200) confirmed the branch exists with its expiry. No other branch was created. Nothing touched the root branch.
- **Cause.**
  - The guarded Neon connector never settled `connect()`, and then `end()`, against an unreachable endpoint. Fixed in PR #29: deadlines, fail closed.
  - The endpoint was unreachable because this Claude session's network sandbox doesn't allow `*.aws.neon.tech`. HTTPS to the endpoint host timed out; Neon's API and other hosts were reachable.
- **Measurements.** M-N1, M-N3 and M-N4 were not obtained. The rerun waits for network access to Neon endpoints. PR #29 merged (`1a2e189`). The owner allowed `*.neon.tech` on 2026-10-20 ("Allow *.neon.tech (Recommended)"), but the running session's sandbox hadn't picked up the setting by 11:20Z.
- **Cap and observed cost.** Neon Free, no card: $0.
- **Cleanup.** The branch expired automatically at 04:22:17Z. Verified at 2026-10-20T11:21:41Z with a read-only branch list (Neon API, HTTP 200): only the root `br-noisy-wind-b7cxr2a1` remains.
- **Open unknown outcomes.** None (reconciled above).
