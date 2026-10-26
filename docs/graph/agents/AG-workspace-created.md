---
id: AG-workspace-created
type: agent
kind: installable
title: Teammates Morrow creates (workspace-created agents, from an agent card a person approves)
status: planned
origin: workspace
slip_rank: "1"
scopes_optional: [read_products, write_products, write_files, read_orders, read_inventory, read_locations, write_discounts]
customer_data: level1
computer: "yes"
links:
  composes: [SK-listing-content, SK-seo-metadata, SK-tags-and-collections, SK-image-alt-text, SK-discount-proposals, SK-promotion-plan, SK-daily-pulse, SK-weekly-review, SK-sales-investigation, SK-stock-cover, SK-reorder-planning]
  installs_as: [IK-installed-agent]
  never_holds: [workspace.task.delegate, agents.builder.describe, agents.installation.activate, support.case.read, support.reply.propose]
  waits_on: [GATE-specialist-packet]
  governed_by: [ADR-0037, ADR-0024, ADR-0011, ADR-0027]
---

The second origin of the one agent kind (ADR-0037 item 4). This node documents the kind; each
agent Morrow creates is a workspace's own record under FORCE RLS and never appears in this graph.
Morrow drafts one with `agent.propose` as an agent card (AgentProposal@1): the model writes the
name, purpose, instructions and any skill text, picks first-party skills by id (pinned by digest)
and tools from the fixed catalogue; code derives the capabilities, verbs, Shopify scopes, data
classes, store, triggers, run limits and model profile. A person approves the exact card ("Add to
team") under ADR-0011's access-change review, and one transaction creates the workspace package,
a fresh principal, the installation, its grants and any 90-day mandate.

Once created it is a teammate like a first-party agent: the same runtime, catalogue, authority
checks at every tool call, stops, run limits, credit holds, rules, notebook and retention, on the
Team page as "Made by Morrow". It never holds an `agent.*` tool, `workspace.task.delegate` or an
`agents.*` capability (depth 1), never Level 2 customer data or `support.*` at launch, and a card
that writes to the store, reads orders, spends or messages customers needs the Owner (ADR-0037
item 5). At most 10 active per workspace; Morrow may suggest removing one idle for 30 days. No
money cap: credits are the only spend limit (ADR-0037 item 6).

`composes` lists the card-eligible skills a card may pick; `scopes_optional` the scopes code may
derive from a card's tools. The code's allowlist stays the authority. Its slip rank is the retired
specialist's: agent cards move to the first fast follow if G11 is missed or the agent-card
authority packet is not merged by G18 (ADR-0037 item 9). V1-PR26, by ADR-0037's follow-up PRs.
