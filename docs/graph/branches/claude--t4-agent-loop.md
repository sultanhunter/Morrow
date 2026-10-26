---
id: claude/t4-agent-loop
type: branch
title: The agent loop (v1 PR 11)
status: open
links:
  implements: [V1-PR11, TRK-agent-platform]
---

Built from 5541e430; AI-reviewed, then opened as PR #64. Merged with main at 66689751 (2026-10-25)
and at 7d726330, 63a8ee74 and da8570ae (2026-10-26; #81's live-evals switch now reads the loop's
record, #78's answers to ADR-0039's readings are built by its plan PRs 3, 7 and 8): its migration, built as 0047, is now 0053 (main's #63 took 0047, #71
0048 and 0049, #67 0050, #70 0051 and #68 0052) and is renumbered again if another PR takes 0053
first; it seeds ToolCatalogue version 3 (#68's knowledge and notebook tools, none offered here).
Brought to ADR-0036's defaults and to the owner's credits-only decision (OD-2026-10-25-4: no money
cap at admission or a turn; a step booked past its own hold still ends the run, ADR-0039 item 9;
the switch's shared_wallet prerequisite waits for the shared wallet's credit holds). Switch
committed off.
