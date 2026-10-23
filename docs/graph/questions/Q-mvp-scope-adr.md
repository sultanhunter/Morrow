---
id: Q-mvp-scope-adr
type: question
kind: do
title: Merge the MVP ADR that supersedes ADR-0021 items 1, 4 and 6
status: answered
asked_of: claude
links:
  raised_by: [OD-2026-10-22-2]
  about: [ADR-0021, ADR-0023]
---

The owner dropped the invite-only beta (OD-2026-10-22-2) and approved the redefined MVP
(OD-2026-10-23-1). ADR-0021 stays Accepted on `main` until the MVP ADR merges: it supersedes
ADR-0021 items 1, 4 and 6, amends ADR-0001 as refined by ADR-0021, and takes the next free number
when it merges. Code that depends on the redefinition waits for it.

Asked of Claude: write the record from the approved draft and merge it with its AI review. A
decision node then `answers` this question.

Answered 2026-10-23: ADR-0023 merged in PR #45, and the owner accepted it as written
(OD-2026-10-23-4).
