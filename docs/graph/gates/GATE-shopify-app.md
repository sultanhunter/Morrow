---
id: GATE-shopify-app
type: gate
title: The owner's Shopify app for the owner's store
label: G3
status: open
owner_kind: owner
due_week: W0
links:
  governed_by: [ADR-0035, ADR-0025]
---

As ADR-0035 shrinks it: the owner creates the custom-distribution app for the owner's own store in
Shopify's developer dashboard, deploys its configuration and seals its client secret with the
owner-run script; then installs it and links the store (V1-PR01's steps). The Partner account, the
public app record and development stores of the original G3 wait for the first outside merchant.
Every live Shopify test waits on it.
