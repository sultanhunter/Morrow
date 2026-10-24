---
id: DC-offline-token
type: data_class
title: The store's offline access token
status: deletion-ready
retention: until uninstall, Disconnect store or rotation
deletion: "its uninstall_or_disconnect handler: the broker destroys the key material on uninstall, a scope change or Disconnect store"
customer: "no"
links:
  deleted_by: [PR-43]
  governed_by: [ADR-0022, ADR-0031]
---

Class `offline_token`. Readable only by the broker Worker. "Disconnect store" (#53) destroys it.
