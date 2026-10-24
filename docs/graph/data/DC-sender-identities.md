---
id: DC-sender-identities
type: data_class
title: Sender identities and the address registry
status: planned
retention: until a person deletes them, the store is redacted or the workspace is erased
deletion: person delete; shop/redact (the shop's Morrow address and its registry digest)
customer: "no"
links:
  deleted_by: [TRK-email]
  governed_by: [ADR-0030, ADR-0031]
---

The workspace's list of sending addresses; the registry keeps only keyed digests (ADR-0030 item 10).
