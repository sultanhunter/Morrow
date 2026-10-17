# P01.T02 contract semantic self-review

Reviewer: Codex (same implementer). Signed declaration: Codex, 6 October 2026. Current basis: canonical sequence 22; core baseline originated at sequence 13. No independent review or integrated-runtime qualification is claimed.

Reviewed 116 named core definitions, 206 closed capability bodies, 94 actor/guard transitions, 15 routes, six ports and 29 contract specifications. Every core definition has a representative schema case. Scope/target/reference/parameter/reviewer binding, expiry, current policy, stale revisions, early answers, uncertainty, cancellation and takeover are explicitly challenged.

Surface revision narrows HostContext and CrossHostResume to standalone. Added closed ConnectorContext for verified installation/store/subject and constrained connection controls. Connector context cannot carry workspace authority, agent execution or credentials. Draft changes have no deployed consumers; historical schema/file names remain where compatible. Migrated earlier Admin-session walkthroughs into standalone-session continuity and added explicit disallowed-surface cases.

The review caught scope/reference inconsistency and corrected exact semantic checks beyond signed hashes. Current fixtures also reject credential fields, unsafe revisions and untrusted bootstrap. JSON Schema alone cannot prove current authority, relational ownership, replay prevention, concurrent state, decimal arithmetic or provider behavior. P01.T04 adds separate billing schemas/arithmetic; implementation packages enforce the contracts.

P01.T03 now records retention, infrastructure, providers, cost and isolation targets. P01.T04 records billing/readiness. Provider nested projections still need closed adapter bodies and conformance; EvidenceRef never validates external payload contents. No paid services or real effects were created. See verification.json and tests.txt; production controls remain future qualification.
