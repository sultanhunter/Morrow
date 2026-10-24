---
id: GATE-deletion-paths
type: gate
title: Each data class's deletion path, before its real data
label: G9
status: open
owner_kind: claude
due_when: before each data class's real data
links:
  depends_on: [TRK-privacy]
  governed_by: [ADR-0031, ADR-0035]
---

Before real data of a class arrives, its deletion path is merged. ADR-0035 item 7: customer classes
keep this exactly; a class that holds no customer data may take the owner's store data first, and
every class has its path before the first outside merchant. The plan gives no week ("G9, before real
data"), so the gate is due per class, before that class's data; the steps that bring real data wait
on it.
