# ADR-0031 Data: retention of the new classes, per-viewer read tags and data regions

- Status: Accepted 2026-10-23 (the owner, OD-2026-10-23-7: every owner question as recommended)
- Date: 2026-10-23
- Supersedes: none.
- Amends: ADR-0022 summary item 13 and decision items 9 (one retention-sweep definer), 13 (new retention rows) and 14 (completion, item 3); the R01 to R03 durations of `capabilities.json`; `data-lifecycle.md`. Refines ADR-0016 items 4 and 5 (read tags on every shared item).
- Implements: ADR-0023 decision 9 and the data part of decision 11e.
- Does not change: ADR-0005, ADR-0007, ADR-0010, ADR-0020. ADR-0025 owns the compliance topics and webhook minimisers; this record sets what their handlers delete and export.
- Terms: the Owner, as in ADR-0024. **Customer data** means a Shopify customer's name, email, phone, address or id, the text of their mail, and anything carrying the `support.case.read` tag. **`dataClasses`**, the field of a specialist's spec, is a subset of item 6's read-tag capabilities minus `support.case.read`.
- Unblocks: P09.T04, P09.T05 (P09.A05), P18.T02, P10.T02, P10.T03, P07.T02, P07.T03, P14.T02, P12.T02, P13.T03, P16.T04, P18.T05; tracks T14 (every deletion path), T4, T6 to T12, T15, T17, T18; gates G9 (per class), G10, G13, G15, G16.

## Context

The owner approved decision 9: "yes to all recommended" (Q12). ADR-0022 assumed customer data is never stored; Support, order reads, run turns, uploads and notebooks change that. `main` has one deletion registry (`redaction.ts`) and its check, S8.

## Decision

1. **Classes and clocks.** Every clocked row and R2 object below carries a non-null `expires_at`, set in code and capped by a CHECK.

   | Class | Kept |
   | --- | --- |
   | `customer_mail`: mail, cases, Level 2 fields, drafts | 90 days after the case's last message; sent-reply records (content-free) 365 days |
   | `order_aggregates` (no customer fields) | 90 days from the order's or day's date |
   | `run_turns` (content) | 90 days from run end; thinking blocks deleted at run close |
   | `run_tool_calls` (content-free: ids, codes, digests) | 365 days |
   | `notebooks` | 90 days after the last write or after being superseded |
   | `uploads` | 90 days from upload |
   | `sandbox_files` | Inputs and the VM end with the run; outputs 90 days from run end |
   | Specialist specs | 90 days after run end |
   | Start documents | 24 hours after use or expiry |
   | Retired run-scoped principals, installations, grants, envelopes and hops | Owner question 1; never while a gateway operation that references them is unsettled |
   | Mandate records and documents | 365 days after the mandate ends |
   | `agent_trigger_sets` | Deleted with the installation; content-free history 365 days |
   | `mail_deliveries` (ADR-0030 item 8, content-free) | 90 days, never while `uncertain` |
   | Webhook inbox receipts (ADR-0025 item 6, minimised) | 7 days |
   | `data_request` exports | 30 days after delivery |

   Tasks, threads, artifacts, knowledge pages, supplier records and sender identities (ADR-0030 item 10) stay until a person deletes them, the store is redacted or the workspace is erased. `sender_address_registry` keeps only keyed digests of live addresses, with no tenant, so no two workspaces hold the same address; each digest is deleted with its sender identity.
2. **Customer data lives only on 90-day clocks.** Customer-tagged content may be written only to tables registered `content: customer`; each row expires no later than the customer items it came from, and copying never extends a clock. Expired or redacted proposal parameters are emptied, keeping the digest; such a proposal never applies. Customer data goes to Claude only in Support's runs; never to the Coordinator, whose context excludes customer-tagged items at launch, nor to E2B, a specialist or a notification email.
3. **What deletes, and when.** Every trigger is a handler in the one registry (item 4), run by a definer from a fixed list. The daily sweep deletes anything past `expires_at` under a maintenance lease, never with BYPASSRLS. `shop/redact`, or 48 hours after `app/uninstalled`, deletes the store's data, the shop's Morrow sending address and its registry digest included (ADR-0030 item 10(b)); "Disconnect store" keeps the clocks. `customers/redact` matches the customer id, a keyed email digest (key in the broker vault) and the listed orders. Agent uninstall deletes the notebook and run turns; uninstalling Support also deletes `customer_mail`. Workspace erasure is `governance.privacy.erase` (`human_only`), and a content-free erasure ledger is replayed after any restore. **Completion:** a privacy request completes only when every handler reports zero remaining, R2 included, and every runtime operation of the store is terminal (ADR-0029); the target is 24 hours, within Shopify's 30 days. Otherwise it stays open as `runtime_absence_unproven`, never reported deleted.
4. **One registry; the deletion path before real data (G9).** `redaction.ts` covers every class, including the specialist rows, whose deletion definer registers its handlers here (ADR-0028 item 9). S8 also fails a `customer` table without a `customer_redact` handler, a clocked table without its CHECK, and a shared table without `read_tags`. A class has its deletion path once its handlers and lab rows pass, in the PR that first writes it; until then its real-data switch stays off. `customers/data_request` delivers, within 24 hours, a customer-tagged export of that customer's rows to the Owner only.
5. **Uploads hold no customer data.** The first sandbox step reads only the header row; a header naming a field from a closed list (email, phone, address, first or last name, customer) deletes the file unread and tells the uploader.
6. **Per-viewer read tags.** A read tag is a store plus one capability from a closed list: `catalog.products.read`, `inventory.levels.read`, `orders.read`, `support.case.read` (the customer tag), `workspace.knowledge.read`, `workspace.artifact.read`. Every shared item stores `read_tags` computed in code (a run's are the union of its tool results' tags; a model never sets them). The api returns an item only when the viewer holds `view` on every tag under live grants; otherwise it is left out of lists, counts, search, digests and exports. Contexts follow the same filter: an installation's under its effective authority, the Coordinator's under the asker's tags minus customer-tagged items, a specialist's under its `dataClasses` and the starter's tags. Sender identities (ADR-0030 item 10) are workspace settings, not shared items, and carry no read tags: a member sees only the active ones they may use, in the review card's picker; the Owner sees the full list and its history; no model context receives it.
7. **Data regions.** `docs/decisions/data-regions.json` lists Neon `aws-us-east-1`; Cloudflare Workers placed in `aws:us-east-1`, with Email Routing on its network; R2 with an Eastern North America hint; E2B US-WEST-1 (G5); Anthropic's global routing; Resend's region (ADR-0030 owner question 2); and WorkOS. The privacy policy's table is generated from it, and `edge:check` fails when it disagrees with placement. A new processor or region changes it first, by ADR.

## Security invariants touched

None is weakened.
- **Tenancy:** new tables are FORCE RLS and listed in S7 and S8; deletion never uses BYPASSRLS (`lab:tenant-conformance`, `lab:retention` and `lab:visibility`, both new).
- **The intersection; checks in code:** read tags only narrow (`lab:visibility`).
- **Unknown outcomes:** a deletion is reported only when proven (`lab:shopify-privacy`). **Broker-only credentials:** the digest key stays in the vault (`broker-vault.test.mjs`).
- **Default deny; no real data before its deletion path:** an unknown tag hides; switches stay off until S8 passes (`lab:tenant-conformance`).
- **Immutable migrations:** `migration-history.test.mjs`.

## Consequences

Residual risks: innocent upload headers can hide personal data; processor copies and backups (up to 35 days) are outside immediate reach.

## Alternatives considered

- **Keep "customer data never stored":** drops Support from the launch floor.
- **Placeholders for hidden items:** they reveal existence.

## Owner questions

1. **Retired specialist authority rows.** (a) Keep them, content-free, while a run, manifest or proposal references them, and at the latest until `shop/redact`, uninstall or erasure; (b) delete them 90 days after the installation ends. Neither while a gateway operation is unsettled. *Recommendation: (a);* (b) cascades through records that reconcile-before-retry needs, for no privacy gain.
2. **Reinstall within 48 hours.** *Recommendation: delete anyway;* one rule to test.
3. **A workspace with no store and no plan.** *Recommendation: erase it 90 days after its last store is uninstalled,* with notices at 30 and 7 days.
4. **Who reads customer data by default.** *Recommendation: the Owner only;* others by a reviewed explicit grant.
5. **Merchants outside the US.** *Recommendation: accept them once counsel confirms at G16,* under each processor's DPA; this depends on ADR-0030 owner question 2.

## Approval

The owner's statement in chat, verbatim, on 2026-10-23 (IST), after reading the decision sheet (`docs/decisions/decision-sheet-2026-10-26.md`) and a plain-language list of its questions numbered 1 to 31, with the other decisions numbered 32 to 38, each with its recommendation (OD-2026-10-23-7):

> approve all as recommended and user should be able to select model and thinking effor for each agent with the main agent set to opus 5.5 high by default and specialist at opus 5.5 medium for email the shop owner should be able to link there emails which will be used for any particual email job like suppose user linked multiple emails(our morrow email will be linked by defualt with user shop name, something like usershopname@morrow.com and selected by default unless user link there emails) and then whenever any email sending related prompt comes user should be able to select which email to choose for that, for now no need to develop the actual capability to link the email but architecture wise it should be like how i explained so we can just add the feature to link users email and it will show in the emails available to use list.

What it approves: this record as written and each owner question above with its recommended answer.

## Amendments

### 2026-10-25: the specialist rows (ADR-0037)

The owner's decision of 2026-10-25 (OD-2026-10-25-3, recorded in ADR-0037 item 8) maps item 1's three specialist rows to the records that replace them, on the same clocks; the text above is kept as approved. Agent cards and their revisions are kept 90 days after approval, dismissal or expiry (for "Specialist specs"); "Add to team" documents 24 hours after use or expiry (as "Start documents"); a removed agent's principal, installation, grants, envelopes and hops as owner question 1 (a) answered for retired run-scoped rows. A workspace-created agent's instructions and skill text are deleted with its notebook and run turns when it is removed (item 3). Result items, which hold a teammate's output too large for one tool result (ADR-0037 item 3(a), from OD-2026-10-25-4), are run content: they keep the read tags of the run that produced them and its `run_turns` row's clock, 90 days from that run's end, and are deleted with its turns.

### 2026-10-26: items 1, 6 and 7, new run content, audiences and processors (ADR-0041 and ADR-0040)

The owner's decision of 2026-10-26 (OD-2026-10-26-7, accepting ADR-0041 and ADR-0040 as recommended, owner questions 11, 13, 14 and 28 included) changes these items as below (ADR-0041 items 14, 25, 27, 29 and 34; ADR-0040 items 16 and 17); the text above is kept as approved.

- **Item 1.** New run-content classes on a per-epoch clock: plans and revisions, checkpoints and compaction summaries, epoch openings (references only), review verdicts, teammate results and result items, and conversation summaries, kept 90 days from the close of each epoch, with a context rolling to a new epoch at least every 30 days; thinking deleted when it stops being sent; content-free records kept 365 days. Person memory kept until the person deletes it ("Still true?" after 180 days unused; erased within 24 hours of membership ending, at workspace erasure and for a removed store's entries); notebooks 90 days after the last write or re-affirmation. ADR-0040's conversation tables on their own clocks. Each class's deletion handler lands in the PR that first writes it (G9).
- **Item 6.** Every derived row carries an audience (the workspace, a subject or one principal) and its source subjects beside its read tags. A read passes only when the read tags allow it, the reader has live view of every source subject, and the audience matches.
- **Item 7.** `data-regions.json` records Anthropic's retention terms for compaction blocks before the provider strategy is switched on, and the browsers' push services as processors.

### 2026-10-26, proposed and not decided: item 1, store-data classes and clocks (ADR-0043)

Not in force. ADR-0043 (Proposed) and the store-data foundation plan (`docs/plan/store-data-foundation-implementation.md`) add classes that item 1 has no row for. This note proposes their clocks for the owner to decide, as question 15 of Q-store-data-foundation; the text above is unchanged and governs until then. When the owner answers, this heading takes the decision's OD number and the rows below become an amendment, as answered.

None of these classes holds customer data under this record's Terms: order ids and order names are not customer data, and no row keeps a name, email, phone, address or note. Every row keyed by an order is still deleted, or has its order id blanked, when a `customers/redact` request lists that order, so the inbox keeps `orders_to_redact` as order ids on its 7-day clock until every handler reports zero remaining (item 3). Each class's handler and CHECK land in the PR that first writes it (item 4, G9).

| Class | What it holds | Kept |
| --- | --- | --- |
| `order_state` (projection) | one current row per order: ids, order name, dates, statuses, totals, closed codes and chosen-tag booleans | 90 days from the order's date, as `order_aggregates`; deleted for the listed orders at `customers/redact` |
| `inventory_levels` (projection) | latest available quantity per (item, location) with `updated_at`; no history | latest values only; deleted at `shop/redact` and 48 hours after uninstall |
| Reconciler high-water marks and projection checkpoints | content-free positions per store and resource family | while the store is linked; deleted with the store |
| Bulk operation records | content-free: operation id, document, state, counts, checkpoints; results are never stored unminimised | 30 days after the operation ends |
| Per-shop Shopify cost budget | bucket levels per (store, app) | latest values only; deleted with the store |
| Subscriptions, schedules, deadline rules and monitors | trigger-set records (closed fields, no store text) | as `agent_trigger_sets`: deleted with the installation; content-free history 365 days |
| Trigger rows, deadline occurrences and monitor alerts | ids, closed codes, counts and times | 365 days, content-free; order ids blanked at `customers/redact` |
| Standing policies and their revisions | the approved digest and its closed fields | 365 days after the policy ends, as mandate records |
| Rule-action logs | policy revision, subject id, action, occurrence, operation, outcome code, times | 365 days, content-free; order ids blanked at `customers/redact` |
| `AutomationUsage@1` (daily usage ledger) | counts, Shopify cost points and provider-reported costs per (workspace, store, kind, day); no subject ids | 365 days |
| Collaboration scope audits (ADR-0044) | content-free refusals and grant changes | 365 days, as `run_tool_calls` |

Classes that later agents add (reorder plans, purchase-order files, supplier mail, marketing audiences and consent snapshots) come with their own records. Counsel's question on India's DPDP Rule 8(3) one-year minimum for processing logs, against the 90-day clocks, stays open, to be settled before that duty takes effect (about May 2027).
