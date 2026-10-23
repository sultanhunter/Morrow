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

   Tasks, threads, artifacts, knowledge pages and supplier records stay until a person deletes them, the store is redacted or the workspace is erased.
2. **Customer data lives only on 90-day clocks.** Customer-tagged content may be written only to tables registered `content: customer`; each row expires no later than the customer items it came from, and copying never extends a clock. Expired or redacted proposal parameters are emptied, keeping the digest; such a proposal never applies. Customer data goes to Claude only in Support's runs; never to the Coordinator, whose context excludes customer-tagged items at launch, nor to E2B, a specialist or a notification email.
3. **What deletes, and when.** Every trigger is a handler in the one registry (item 4), run by a definer from a fixed list. The daily sweep deletes anything past `expires_at` under a maintenance lease, never with BYPASSRLS. `shop/redact`, or 48 hours after `app/uninstalled`, deletes the store's data; "Disconnect store" keeps the clocks. `customers/redact` matches the customer id, a keyed email digest (key in the broker vault) and the listed orders. Agent uninstall deletes the notebook and run turns; uninstalling Support also deletes `customer_mail`. Workspace erasure is `governance.privacy.erase` (`human_only`), and a content-free erasure ledger is replayed after any restore. **Completion:** a privacy request completes only when every handler reports zero remaining, R2 included, and every runtime operation of the store is terminal (ADR-0029); the target is 24 hours, within Shopify's 30 days. Otherwise it stays open as `runtime_absence_unproven`, never reported deleted.
4. **One registry; the deletion path before real data (G9).** `redaction.ts` covers every class, including the specialist rows, whose deletion definer registers its handlers here (ADR-0028 item 9). S8 also fails a `customer` table without a `customer_redact` handler, a clocked table without its CHECK, and a shared table without `read_tags`. A class has its deletion path once its handlers and lab rows pass, in the PR that first writes it; until then its real-data switch stays off. `customers/data_request` delivers, within 24 hours, a customer-tagged export of that customer's rows to the Owner only.
5. **Uploads hold no customer data.** The first sandbox step reads only the header row; a header naming a field from a closed list (email, phone, address, first or last name, customer) deletes the file unread and tells the uploader.
6. **Per-viewer read tags.** A read tag is a store plus one capability from a closed list: `catalog.products.read`, `inventory.levels.read`, `orders.read`, `support.case.read` (the customer tag), `workspace.knowledge.read`, `workspace.artifact.read`. Every shared item stores `read_tags` computed in code (a run's are the union of its tool results' tags; a model never sets them). The api returns an item only when the viewer holds `view` on every tag under live grants; otherwise it is left out of lists, counts, search, digests and exports. Contexts follow the same filter: an installation's under its effective authority, the Coordinator's under the asker's tags minus customer-tagged items, a specialist's under its `dataClasses` and the starter's tags.
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
