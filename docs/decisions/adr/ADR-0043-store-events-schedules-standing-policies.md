# ADR-0043 Store events, schedules and standing action policies for installable agents

- Status: Accepted 2026-10-26 (the owner, OD-2026-10-26-11: this record as recommended, with owner questions 1 to 10 of Q-store-data-foundation answered as recommended; see Approval). Proposed earlier the same day.
- Date: 2026-10-26
- Supersedes: none.
- Amends: each record below gets its dated note in plan row SD2; the text of each stays as approved.
  - **ADR-0024** item 1 (a mandate's trigger set may hold store-event subscriptions, deadline rules, monitors and standing policies, each inside the mandate's trigger kinds and grants), item 6 (admission from event, deadline and monitor rows, with batching windows, a per-installation run rate, combined resume when credits return, and rows that fall due during a stop dropped rather than retried) and item 9 (plan bundles: one typed confirmation over pending proposals of several capabilities on one store).
  - **ADR-0011** Q3, through ADR-0024 item 9 (the plan bundle's phrase and its strictest-rule merge) and Q9 (the standing-policy review: an access change merged with the class rule of the policy's capability).
  - **ADR-0025** item 6 (the topics a store subscribes to are its app and compliance topics plus the union of its active installations' subscriptions within granted scopes; trigger rows written in the inbox-apply transaction). Item 4's other parts (`includeFields` at source, deduplication on Shopify's event id, Queue ingress, per-shop limits and combined inventory events) carry out item 6 as written and are routine under ADR-0002, not amendments.
  - **ADR-0027** item 3 (two drafting tools, `routine.draft` and `rule.draft`, neither with an external effect).
  - **ADR-0031** item 1 (the new classes and clocks, in the dated note in that record, question 15).
  - **ADR-0039** items 2(a), 2(d) and 3 (code-only work metered and not charged until rate card v1, never blocked by credits when time-critical; proactive triggers waiting on credits combined into one run per installation, each row re-checked as it merges), under item 1 as OD-2026-10-26-12 restated it (credits are the only budget).
  - **ADR-0040** item 12 (a standing request's schedule is `Schedule@1`, in place of its cron subset).
  - **ADR-0041** item 7 (the lease-source table names the trigger kinds `admit_mandate_run` admits from and states that `admit_bounded_action` issues no lease; a run's follow-through beyond its envelope may continue only as a code-written `once` schedule whose episode is a successor, item 9), item 9 as OD-2026-10-26-12 amended it (combined resume of triggers waiting on credits; nothing waits on Morrow's provider spend, item 22), item 20 (deadlines and monitors as episode triggers; a `once` schedule's episode inherits the run's taint and read tags, fires only under the mandate revision it was written under, and is cancelled with its run when a stop, revocation, kill switch, authority failure or the mandate's end ends that run, item 9) and item 35 (the conditional runtime SQL object, if built, also serves the trigger writers, `admit_bounded_action` and the contact definers).
  - **ADR 0042** (connected services and customer contact, Accepted as recommended on 2026-10-26 by OD-2026-10-26-9, which its records PR records: pull request 86, row CS1 of its plan): item 10 (`ContactRule@1` becomes the contact case of `StandingPolicy@1`, the one named exception of item 15 below, `standing_policy: contact_plan`, under its own approval and checks; "for this capability only" stays true of that exception), item 12 (`admit_contact_attempt` becomes the contact case of `admit_bounded_action`, with every check it has), item 14 (stops through one shared check; `contact.stop` covers every `communication` capability of the "Customer contact" domain and every action of a call plan, its tag writes included, and never blocks the domain's controls or reads, item 20; its rule that lifting a stop resumes no plan applies to every policy), item 18 (`OrderEventFilter@1` becomes the predicate set of `StoreEventSubscription@1`; the 5-minute sweep becomes the shared reconciler's orders consumer, run from the orchestrator's cron, item 6; order events become a trigger kind for agent runs), item 19 (tag writes under a standing policy, through the gateway's mutation registry), item 23 (its credit rule generalised to all code-only work) and its owner question 17, answered (a) "later, by its own change": this record is that change.
  - **CLAUDE.md**, three lines, each as ADR 0042's CS2 will commit it (ADR 0042 question 6's lines 1, 2 and 4; its line 3, the ask before sending to customers, is unchanged): the security invariant "Approvals are bound to a digest of the exact proposal …", the security invariant "The owner's own store is the only real store … Agents change it only through …", and the provider and live effects rule "Change the owner's store only through Morrow's own flow …". ADR 0042's four lines are approved in substance only: their exact text was added to its sheet after the owner's answer, so CS2 commits it only once the owner confirms it word for word (OD-2026-10-26-9; question 6 of Q-adr-0042-owner-questions). The exact current and proposed text of these three is on Q-store-data-foundation, question 5. They land as their own change after CS2's, once the owner confirms those words too (OD-2026-10-26-11); the owner can confirm both sets of words in one message.
  - **Contracts:** `StoreEventSubscription@1`, `Schedule@1`, `DeadlineRule@1`, `Monitor@1`, `StandingPolicy@1`, `PlanBundleDocument@1`, `AutomationUsage@1`; `capabilities.json` gains `workspace.rule.propose`, `workspace.rule.activate`, `workspace.rule.pause`, `workspace.rule.revoke`, `orders.tags.remove` and `orders.app_note.set`, and a `standing_policy` field on each capability (`eligible`, `contact_plan` for `contact.attempt.send` only, or absent); the tools of item 13.
  - **Build plan:** lettered children only (`docs/plan/store-data-foundation-implementation.md`).
- Does not change:
  - ADR-0005: every stop stays `human_only` with no second approver, and agents only propose stops. The two rule controls this record adds follow its item 1 exactly.
  - Approval of exact content, and the one gateway that re-checks, applies, reads back and audits.
  - Unknown outcomes are reconciled before any retry and never promoted.
  - Credentials are readable only by the broker. FORCE RLS and server-derived tenancy. Default deny.
  - ADR-0031 item 2 and ADR-0025 item 8: customer data reaches Claude only in Support's runs. A run that a store event, a deadline, a monitor or a schedule starts receives Level 1 data only. Agents that look at individual customers need their own record (Not decided here).
  - ADR-0039, OD-2026-10-25-4 and OD-2026-10-26-12: credits are the only budget. Nothing in this record pauses, checks in or refuses work on an amount of spend, and it adds no per-person cap. Its counts, rates, windows and caps (runs an hour, ids a row, subjects a day, open questions and schedules) are non-money safety or rate limits, and its per-shop buckets for Shopify's API query cost (plan row SD5) are Shopify's rate limit, counted in Shopify's cost points, not money.
  - ADR-0041: Morrow's own harness, Opus 5.5 for every agent, one run per trigger key, envelopes, parks and check-ins.
  - ADR-0035 items 1 and 2: one environment, and the owner's store is the only real store until launch.
  - ADR-0038 item 2: the connector's cron object runs only the connector's existing re-drives. The reconciler and `fire_due_schedules` run from the orchestrator's cron under explicit time budgets (items 6 and 9).
  - ADR-0030 item 8, as ADR-0040 amended it: notifications stay content-free, so an alert's notification carries no order number (item 11).
  - ADR-0005 item 1: every stop and rule control records a reason, writes an audit record and notifies the Owner.
- Implements: the owner's direction of 2026-10-26, given with the approval of ADR 0042, that installable agents such as COD Confirmation run on a foundation that consumes live store data and performs scheduled actions (quoted under Context), under the owner's production-grade rule of the same day (OD-2026-10-26-6).
- Relies on:
  - the gateway (V1-PR03) and the stops of P11.T05;
  - mandates (V1-PR21) and the agent loop (ADR-0041), for model runs only; the code paths run no model;
  - `read_orders` and the order data's deletion path (V1-PR22), and the customer-data deletion base (P09.T05, plan row SD4);
  - webhook ingress (P09.T04), the shared reconciler, projections and the per-shop buckets for Shopify's API query cost, a rate limit and not money (plan rows SD5 to SD9);
  - ADR-0044 (collaboration grants), for any agent post or question that a trigger leads to.
- Companion: ADR-0044 (collaboration grants for installed agents), and a dated note on ADR-0031 item 1. Their owner questions share one decision sheet, Q-store-data-foundation.
- Plan: `docs/plan/store-data-foundation-implementation.md`.
- Terms:
  - **Subscription:** one installation's interest in one store topic, with closed predicates (`StoreEventSubscription@1`).
  - **Trigger row:** one server-held row that may admit one mandate run (ADR-0024 item 6) or feed one standing policy. It holds ids and closed codes only.
  - **Window:** the batching period over which one subscription's matching events become one trigger row.
  - **Deadline:** a condition that becomes true when time passes ("unfulfilled for 48 hours"), checked by code over a projection.
  - **Monitor:** a metric computed in SQL compared with a threshold, which posts an alert built by code.
  - **Standing policy:** a person's one exact approval of a small, reversible action that code may then take for each subject a trigger names, within caps (`StandingPolicy@1`). ADR 0042's call plan is its one named exception: an irreversible contact under that record's own approval and checks (item 15).
  - **Subject:** the store record one action is about (at launch, an order).
  - **Occurrence:** one firing of a policy for one subject, held as one occurrence row that only code writes (item 17): the subject's first match of a subscription's predicates since it last stopped matching, one deadline instance, or one schedule slot.
  - **Code-only work:** steps that run without a model: ingestion, reconciliation, projections, sweeps, rule actions and dispatch.

## In plain words

The owner approved ADR 0042 and asked that COD Confirmation be an agent people install, and that Morrow's foundation be ready for agents that use live store data, such as orders, and do things on a schedule. This record says how any installed agent reacts to what happens in the store, keeps a schedule, and takes small actions without asking every time.

- **Agents can react to the store.** An agent can ask to hear about new or changed orders, products or stock. When something matches, Morrow notes it in a record of its own, never acting on the text Shopify sends, and either starts the agent or runs an approved action in code. Bursts are grouped, so 300 orders in a minute start one job, not 300.
- **Agents can keep time.** Schedules run in your shop's own time zone, read from Shopify, so an Indian shop can say "every day at 9 am" in India time. Clock changes never skip or double a run.
- **Agents can watch deadlines and numbers.** "Tell me when an order has been unfulfilled for 48 hours" and "warn me when a best seller has under 14 days of stock" are checked by code, which posts the alert itself. The AI is only asked to explain or draft something.
- **Small, reversible actions can run on one approval.** You approve the exact action once, for example "tag late orders `morrow-late`, up to 200 orders a day", and code then does it for each order that qualifies, through the same gateway that applies, reads back and records every change. Cancelling, refunding, changing prices, discounts or stock, and anything that cannot be undone still need your approval each time. ADR 0042's call plans, which you approved with their own checks, are the one exception, and they stay as that record wrote them.
- **Everything stops at once.** Any stop, and two new controls, Pause rule and Revoke rule, halt these actions at their next step. Nothing that fell due while stopped is done in a burst afterwards, and lifting a stop turns no rule back on by itself.
- **No surprise bills.** Work that runs without AI is counted but not charged until the rate card prices it, and running out of credits never blocks a time-critical action. AI runs still use credits as today.

A worked example, for an order-operations agent that is not built yet:

1. You install it. Its setup guide asks for Shopify's `read_orders` and `write_orders`, then shows one review card: a daily digest at 09:00 in your shop's time zone; a deadline, "unfulfilled for 48 hours"; and two standing policies approved as a pair, "tag those orders `morrow-late`, up to 200 a day" and "remove `morrow-late` once they ship, up to 200 a day". You type one phrase.
2. On Wednesday at 10:05 an order placed on Monday at 10:00 is still unfulfilled. Code's deadline check notes it; `admit_bounded_action` checks the policy, the stops and the caps; the gateway adds the tag and reads it back. When the order ships, the removal policy finds that its pair wrote the tag, and the gateway takes it off.
3. At 09:00 the next day the agent's scheduled run reads the counts, posts the digest in its area and asks you one question (ADR-0044).
4. You press Stop AI work on Thursday. The orders that become late while it is stopped are not tagged. Starting the agent again leaves the tagging rule off until you turn it back on with its review; then only orders that become late afterwards are tagged, unless you choose to include those from the last 24 hours that still qualify.

## Context

**The owner's direction.** On 2026-10-26 the owner approved ADR 0042 as recommended, in a message whose first words approve it and are recorded, verbatim and in full, as OD-2026-10-26-9 in that record's records PR (pull request 86). The rest of the message, verbatim:

> this COD confirmation agent will be a installable agent by the user(no need to build the actual agent for now just make sure our foundation is solid enough to support these types of agents which can consumes store live data like orders/customers etc and performa scheduled actions etc.)

Earlier that day the owner set the rule for the foundation: production-grade, with no MVP shortcuts (OD-2026-10-26-6). ADR 0042's question 7 (a) already made COD Confirmation a first-party package that a person installs, and its question 17 (a) left order events as a general trigger for agent runs "later, by its own change".

**What the foundation audit found.** Four read-only audits of 2026-10-26, one for each kind of agent (COD Confirmation; an order-operations agent on schedules, events and deadlines; customer retention; inventory and purchasing), were merged into one gap report. The base design holds: long runs, tenant isolation, key custody, digest-bound approvals and a gateway that writes then reads back. The store-data side is mostly unbuilt, and ADR 0042 builds a pipeline that only COD can use. The parts that need an owner decision are here; the routine parts are rows of the plan.

- **Triggers.** `shopify_event` and `monitor` already exist as trigger kinds, and `admit_mandate_run` admits one run per trigger key (ADR-0024 item 6). Nothing defines which topics may start runs, what a trigger row carries, how bursts are grouped, how many runs an installation may start, how missed events are replayed, how per-order deadlines are checked, or how a monitor alerts without a model run. On `main` the webhook sync registers only `app/uninstalled` and `app/scopes_update`.
- **Schedules.** The shop's zone comes from a closed list of four Canadian zones; nothing reads `shop.ianaTimezone`. Mandate routines carry only daily, weekly or monthly; `StandingRequest@1` has its own cron subset; daylight saving and missed slots exist only as plan text; nothing names the writer of schedule trigger rows.
- **Standing approvals.** The only one is ADR 0042's `ContactRule@1`, "for this capability only". Every other small, reversible action (a tag on a risky order, an app-owned note, a tag removed when an order ships) would be a proposal per order, and batches stop at 50 proposals of one capability. A reorder mixes capabilities, so a solo Owner pays the phrase and cool-down twice. Copying ADR 0042 per agent would repeat its definers, its review card and its CLAUDE.md exception.
- **Stops.** The stop check is written for contact; `contact.stop` lists three capabilities, so a new contact capability would fall outside it; generic rules have no pause or revoke; "no burst on resume" is defined only for contact.
- **Credits.** Model runs hold credits (ADR-0039, ADR-0041 item 9). Code-only steps have no metering and no price, so an empty wallet would either block a time-critical action or let it run uncounted, and triggers waiting on credits could all fire at once when credits return.

**Why it is material.** It changes authority (a standing approval for store writes; new trigger kinds for agent runs), money (credits for code-only work), public contracts and data retention. Each needs the owner's approval before dependent code (CLAUDE.md, ADR-0002). The schedule contract, the shop's zone and the firing of recurring schedules (items 7 and 8, and item 9 without `once` schedules) are routine under ADR-0002 and may start before the owner answers; they are here so that every trigger kind builds on one schedule contract. Item 9's code-written `once` schedules are not routine: they change ADR-0041 item 7's envelope rule, so they are an amendment of that record.

## Decision

### A. Ground rules

1. **Code first; the model drafts and explains.** Time-critical and repetitive work (calls, tags, alerts, counts) runs on code paths with no model. A model run starts from a trigger only to explain, draft or decide something a person will see, and it reads store data through fixed broker documents under its installation's grants. Text from a webhook, a product, an order or a provider never selects a tenant, a store, an installation, a plan, a policy, an action or a recipient.

2. **Level 1 only.** A run started by any trigger in this record receives no customer data (ADR-0031 item 2, ADR-0025 item 8). Code paths may use a Level 2 field only as ADR 0042 item 15 allows for the phone: read by the broker at dispatch, never kept or shown. Order ids and order names are not customer data under CLAUDE.md.

### B. Store events

3. **`StoreEventSubscription@1`** (closed, RFC 8785 digest), one row per installation and purpose, revised append-only:
   - **Topic** from a closed list: the topics ADR-0025 item 6 approves (`products/create`, `products/update`, `products/delete`, `inventory_levels/update`, and under `read_orders` only `orders/create`, `orders/updated`, `refunds/create`). Any other topic needs a dated amendment to ADR-0025 items 6 and 7 for the agent that needs it, with a closed minimiser and its scope.
   - **Predicates** from a closed list, evaluated in code on the minimised record, never free-text expressions. Orders: payment class, financial and fulfilment status, a total range in the order's currency, a chosen tag present or absent (from the closed set of tags the Owner picks), source, age. ADR 0042's COD test is one predicate (`payment_class = cod`). Products: status, a changed-field class (`title`, `body`, `media`, `price`, `status`), a collection from a list the Owner picks. Inventory: available quantity crosses a threshold, location in a list.
   - **Action**, exactly one: `run` (start a mandate episode), `policy` (feed one standing policy, item 14, with no model: the apply step writes an occurrence row, item 17, for each subject that begins to match), or `monitor` (re-evaluate one monitor, item 11).
   - **Window** (`coalesceSeconds`): 0 to 3,600, default 300 for `run`, 0 for `policy`.
   - **Rate:** at most `maxRunsPerHour` runs per installation from all its event, deadline and monitor triggers together (catalogue value: default 6, at most 60; a count, not money). Recurring schedules are bounded by their own frequency (item 7); code-written `once` schedules count toward this rate (item 9). A row over the rate is never dropped inside the replay horizon: it merges or waits (item 5).
   - **Age:** an event whose change is older than the subscription's `maxEventAge` when it is applied (measured from its `updated_at`, or from the order's `createdAt` for `orders/create`), as after a late delivery or the reconciler's replay, starts no run and opens no occurrence; it still updates projections (catalogue value: default 24 hours, the replay horizon; 5 minutes to 24 hours; ADR 0042's 30-minute transactional window is one value).
   - **Who sets it.** A subscription is a trigger-set revision (ADR-0024 item 1): a run may draft one with `routine.draft` under `workspace.routine.configure`; a person activates it with `workspace.routine.activate` (human_only), inside the mandate's trigger kinds. Its topic's scope must be granted, and the package must declare the topic (AgentPackage@2).

4. **The store's topic set.**
   - **The amendment** (ADR-0025 item 6): the topics a store subscribes to are its app and compliance topics plus the union of its active installations' subscriptions, limited to granted scopes. Until AgentPackage@2 declares subscriptions (plan row SD10), the union is a static per-package map.
   - **Routine, carrying out ADR-0025 item 6 as written:** the broker's sync lists, then creates or deletes, as reconciled operations, never blind. Each data subscription sets `includeFields` to exactly its minimiser's fields, so fields Morrow never keeps (a phone, an address, a note) are not sent at all. Deliveries are deduplicated on `X-Shopify-Event-Id` as well as the webhook id. Topics with no customer data go through a Queue after the HMAC check, with limits per verified shop (plan row SD6); inventory events are combined to the latest per (item, location, `updated_at`).

5. **Trigger rows** (amends ADR-0024 item 6).
   - An event trigger row is written only in the inbox-apply transaction that stores the minimised receipt, including the shared reconciler's synthetic receipt (item 6). Schedule, deadline and monitor rows come only from their own writers (items 9 to 11). No other path writes a trigger row.
   - A row holds ids and closed codes only: tenant, store, installation, subscription revision, topic, window start, up to 500 resource ids with an `overflow` flag (the run then reads by query), and a count. No payload text. A combined row (item 22) holds, for each source merged into it, that source's revision, its trigger kind, its ids and its own `overflow` flag, within the row's 500-id cap; it too holds ids and closed codes only.
   - One row per window, keyed `ev:<installation>:<subscription>:<window start UTC>`, unique. The first matching event opens the window; later matches add their ids.
   - Over the installation's hourly rate, an event or deadline row's closed window merges into the next one the rate allows, keeping every id. A row with no ids to merge, a monitor's `alert_and_run` row or a `once` schedule's row (item 9), waits unchanged for the next slot the rate allows. Rows over the rate go oldest first, and nothing is dropped inside the replay horizon (24 hours).
   - `admit_mandate_run` admits the run (ADR-0024 item 6, as ADR-0039 amended it): mandate, trigger kind, the subscription revision still active, quiet hours (the row waits until they end), stops, credits, one run per trigger key. The run reads the named records through fixed documents under its own grants and is tainted by what it reads, as today.
   - A row expires 24 hours after its window closes.

6. **Missed events.** One shared reconciler per (store, resource family) keeps a durable high-water mark on `updated_at` with an overlap, and writes synthetic receipts through the same minimiser and the same dedupe key (topic, resource id, `updated_at`) as real deliveries, so every consumer (projections, trigger rows, policies, ADR 0042's contact sequences) sees each change exactly once, and an older `updated_at` never overwrites a newer one. Subscriptions are re-listed hourly while a package marked time-critical is active, otherwise daily. It runs from the orchestrator's cron under explicit time budgets (ADR-0038's consequence note; time, not money), which puts each tenant's work, as ids, on a Queue; ADR-0038's connector object keeps only the connector's existing re-drives (its item 2, unchanged), and ADR 0042 item 18's 5-minute sweep becomes the reconciler's orders consumer. The reconciler is routine (plan row SD7); this item makes it the only replay path for triggers.

### C. Schedules, deadlines and monitors

7. **`Schedule@1`**, one contract for mandate routines, standing requests (amends ADR-0040 item 12), reports and policy triggers:
   - **Kinds:** `daily` (up to 4 local times, on 5-minute marks), `weekly` (days of the week and one time), `monthly` (a day 1 to 28 or `last`, and one time), `every` (15, 30 or 60 minutes, or 2, 3, 4, 6 or 12 hours) and `once` (one UTC instant, written only by code under item 9's bounds; not routine, since it amends ADR-0041 item 7).
   - **Zone:** an IANA name. **Missed slots:** `skip` or `run_latest_once` (reports use `run_latest_once`). **Optional** start and end dates.
   - **Daylight saving:** a local time that does not exist fires at the next valid minute; a repeated hour fires once, at its first occurrence.
   - Nothing runs more often than every 15 minutes.

8. **The shop's time zone, from Shopify.**
   - The broker reads `ianaTimezone` in the ShopIdentity document at link, at reconnect and in the daily health read. The full IANA list replaces the four Canadian zones, with an Owner override.
   - Every schedule stores its zone. A change of the shop's zone never moves a schedule silently: it raises one Inbox item for the Owner and each schedule's owner, "Your shop's time zone changed to Asia/Kolkata. Move 3 schedules?", and each schedule moves only on a person's tap.
   - **Which zone applies where:** customer contact uses its region policy's zone (ADR 0042 item 13); mandate routines, reports, deadlines and monitors use the shop's zone; a standing request uses the shop's zone unless its signer picks their own; notifications use each person's quiet hours.

9. **Firing schedules.**
   - One ids-only definer, `fire_due_schedules`, executable only by `morrow_runtime_executor`, writes one trigger row per (schedule, slot), keyed `sched:<schedule id>:<slot UTC>`, unique. It is called per tenant from the orchestrator's cron under explicit time budgets (ADR-0038's consequence note; time, not money), or through ADR-0041 item 35's object if staging shows the distance problem.
   - For a schedule that triggers a standing policy, the same transaction runs the policy's closed subject query (item 12) in SQL over the projection and writes one occurrence row (item 17) per subject it selects, oldest first, up to the policy's remaining cap for the day. A model never chooses the subjects.
   - **`once` schedules** (amends ADR-0041 items 7 and 20). A run's follow-through beyond its envelope (ADR-0041 item 17) may continue only as a `once` schedule that code writes under the mandate; a model never writes one directly. Bounds:
     - at least 15 minutes after it is written, and at most 20 open per installation;
     - its episode counts toward the installation's `maxRunsPerHour` (item 3), with the event, deadline and monitor triggers;
     - its episode is a successor of the run that wrote it: it inherits that run's taint and read tags and its unreconciled operations (ADR-0041 item 20);
     - it fires only under the mandate revision that was active when it was written: once that revision is renewed, taken over, revoked or ended, the schedule ends `cancelled` and admits nothing, since a later trigger under a new mandate never continues an episode (ADR-0041 item 20);
     - the transaction that ends its run by a stop, a revocation, a kill switch, an authority failure or the mandate's end also ends every open `once` schedule that run wrote, `cancelled`, so lifting the stop never starts a successor: only a person's Continue in session may (ADR-0041 item 20). Any stop over the installation (the platform, workspace or installation stop) likewise ends the installation's open `once` schedules when it begins, whether or not their run is still running;
     - over the hourly rate it waits for the next slot the rate allows and is never dropped inside the 24-hour replay horizon (item 5); while it waits on credits it never combines with trigger rows, since it is a run's own follow-through and not a trigger, and it resumes on its own, oldest first, as a parked job does (ADR-0041 item 9; item 22);
     - that episode cannot write another `once` schedule, so they never chain.

10. **Deadlines: `DeadlineRule@1`.**
    - A closed condition preset over a projection (plan row SD9): `unfulfilled_for`, `unpaid_for` (a pending manual payment, such as COD), `tag_present_for`, `cancel_requested_unresolved_for`; a duration from 1 hour to 30 days; item 3's predicates to narrow it; and an action: `run`, `policy` or `alert`.
    - A per-tenant SQL sweep every 5 minutes writes one row per (rule revision, subject, occurrence), keyed `dl:<rule revision>:<subject>:<occurrence>`, unique. A subject that leaves the condition and enters it again opens the next occurrence.
    - For `run`, due rows in one window combine into one trigger row per installation, as in item 5. For `policy`, the sweep writes one occurrence row (item 17) per due subject, whose entry is the time the subject entered the condition. For `alert`, item 11's alert rule applies.
    - A rule refuses to activate (`projection_incomplete`) until the projection covers the store's last 60 days (plan row SD8).

11. **Monitors: `Monitor@1`.**
    - A metric from a closed list, computed in SQL in the shop's zone (`stock_cover_days`, `sales_velocity`, `inventory_available`, `unfulfilled_count`, `refund_rate`), a comparison and threshold, a scope (products, variants or locations from a list the Owner picks, or all), and an evaluation schedule or subscription.
    - **Code posts the alert.** When the condition holds, code writes at most one alert per (monitor, scope group, window), keyed `mon:<installation>:<monitor>:<scope group>:<window>`: an Inbox item for the installation's owner and a system post in the agent's area conversation, built from a template with counts and ids only. Product and variant titles are rendered from those ids when a person views the item, under that viewer's read tags; the stored post holds no store text, so a run that later reads the area reads ids, and gets titles only through fixed broker documents that taint it as usual. A thousand inventory events give one alert per window.
    - **Notifications** about an alert follow ADR-0030 item 8 as ADR-0040 amended it: content-free, so no order number or title. An order-number variable in notifications would need its own dated note on ADR-0030 item 8, decided by the owner.
    - **Actions:** `alert`, or `alert_and_run`, which also writes one trigger row per window for a mandate episode that explains the alert or drafts a proposal. A model run never decides whether to alert.
    - Default window 24 hours, at least 1 hour.

### D. Standing action policies

12. **What a standing policy is.** `StandingPolicy@1` is closed and digested with RFC 8785. Its digest binds:
    - the store, the installation and its mandate revision;
    - its trigger: one subscription revision, deadline rule revision or schedule;
    - one capability from item 15's allowlist (or, for contact, item 15's one exception), with its exact parameters (a tag from a closed list, a note template and its closed variables), and, for `orders.tags.remove`, its paired `orders.tags.add` policy: that policy's id, of the same store, installation and tag (item 15);
    - per-capability content digests (for contact, ADR 0042 item 10's templates, renderer, voices and segments);
    - the subject audience: for a subscription or a deadline rule, the trigger's predicates; for a schedule, which has no predicates, a closed subject query (item 3's order predicates and a closed age range, evaluated in SQL over the projection at the slot, item 9). The subject must still meet them when the action is admitted and on the gateway's live read (item 17);
    - caps, which are counts and not money: subjects per day (Owner-set at approval, default 200, at most 2,000), actions per subject per occurrence, and optional hours;
    - an outcome map, for capabilities with steps (contact);
    - an optional holdout share (ADR 0042 item 25's method, generalised as `Holdout@1`);
    - an expiry no later than its mandate's.

    The model writes none of the content: `rule.draft` picks presets and list values, and code fills the rest. Person-only fields (caps above their defaults, a holdout above its default, any field ADR 0042 item 10 names) are set only on the review card.

13. **The tools** (amends ADR-0027 item 3). `routine.draft` writes a draft schedule, subscription, deadline rule or monitor from closed presets (`workspace.routine.configure`); `rule.draft` writes a draft standing policy (`workspace.rule.propose`). Neither has an external effect, grants anything, names a recipient, a URL or a credential, or sets a person-only field (`tool-catalogue.test.mjs`). ADR 0042's `contact.rule.draft` becomes the contact form of `rule.draft`.

14. **Approval and life.**
    - **Who.** Activation is `workspace.rule.activate` (control, `human_only`, review-required), reviewed as an access change merged field by field with the class rule of the policy's capability, taking the stricter value (amends ADR-0011 Q9). Any policy whose capability changes the store or contacts anyone needs the Owner as requester or approver (as ADR-0037 item 5 does for cards). In a team, ADR-0024 item 2 and its owner question 1 (b) apply.
    - **The card** shows the policy in plain words, the trigger, the action and its exact parameters, an example subject (an order number and total, never a customer's details), the caps, the estimate of actions a day from the last 30 days, the undo path, and what is never done. For a tag it also warns that the shop's own automations (Shopify Flow, other apps) may act on the tag, and that Morrow cannot undo what they do, as ADR 0042 item 19's setup guide does.
    - **The phrase** is exact: `approve <action> for up to D <subjects> a day`, for example `approve tagging up to 200 orders a day`. A solo Owner waits out the 300-second cool-down and may cancel. A removal policy (item 15) is first approved together with its paired add policy, on one card under one phrase and one cool-down, each digest its own, for example `approve tagging up to 200 orders a day and untagging up to 200 a day`; a later revision of either is reviewed on its own.
    - **At setup**, one review document holds the install with its mandate and its first policies, up to 4 digests, under one phrase and one cool-down, generalising ADR 0042 item 10's setup document. Each digest stays its own: an edit to any is a new document.
    - **Life.** A policy ends with its mandate (one renewal card covers both), its installation, a lost grant or scope (ADR-0025 item 10), a lost connection (ADR 0042 item 8), or the end of its approver's membership. Any edit is a new revision that needs a new approval; until it passes, the old revision keeps running or pauses, as the editor chose. An action is admitted only under the active revision, and its row records the digest it ran under.

15. **The allowlist: reversible and bounded only.** A capability may carry `standing_policy: eligible` in `capabilities.json` only if its `effect` is `external_write` (never `communication`, `spend` or `billable_job`), it has `irreversible: false`, its effect can be undone by a person, it has fixed parameters, and it moves no money and changes no stock, price, discount, fulfilment, customer record or cancellation. At first:
    - `orders.tags.add` (ADR 0042 item 19): one tag from a closed list, only tags that start `morrow-` or that the Owner picks at approval; `tagsAdd`, never replacing the order's tags. The rule-action log records whether the tag was already on the order (`already_present`), in which case nothing is written;
    - `orders.tags.remove`: only in a removal policy paired with one `orders.tags.add` policy of the same store, installation and tag, which its digest binds (item 12) and with which it is first approved (item 14). It has its own trigger and subject audience, for example `orders/updated` with fulfilment status `fulfilled` and the tag present. It is admitted for an order only when the paired policy has recorded a write that put the tag on that order (an add that found it `already_present` wrote nothing and is not one) and no removal of that tag on that order has been recorded since that write; otherwise it is refused (`tag_not_added_by_policy`). So it never strips a tag that was on the order before its pair wrote it; an add that finds its own earlier tag still present records `already_present` and does not block the removal; and after a removal, the next waits for a new write. The pair's pause or end does not end the removal policy, which keeps its own life (item 14), so tags the pair wrote can still come off;
    - `orders.app_note.set`: a note in the app-owned `$app` metafield namespace from a template with closed variables, never the merchant's own order note.

    Each further capability enters the list only by a dated amendment to this record.

    **The one named exception: ADR 0042's call plan.** `contact.attempt.send` is irreversible and in the communication class (ADR 0042 item 9, which puts it on ADR-0011 Q4's irreversible list), so it is not eligible and never becomes so through this item. It carries `standing_policy: contact_plan` instead, carried over from ADR 0042 item 10's own approval: an approved `ContactRule@1` revision covers its contacts only with that record's review (the communication class's rule, the Owner as requester or approver, the owner's OK in chat before the first live day) and with every check of its item 12 (region policy, suppression, per-number caps, settled earlier attempts, holdout). `StandingPolicy@1` lends it only the shared parts: the record's life, pause and revoke, `effect_stops_clear`, the shape of the admission definer and `PolicyActionWorkflow`. It widens nothing ADR 0042 approved. No other capability may carry `contact_plan`; another exception needs its own record.

    `capabilities.test.mjs` (new, plan row SD17) fails any capability marked `eligible` whose `irreversible` is true or whose `effect` is not `external_write`, and any capability other than `contact.attempt.send` marked `contact_plan`.

    `lab:standing-policies` rows for removal: a removal policy without a paired add policy of the same store, installation and tag refuses to activate; a removal after the pair wrote the tag takes it off; a removal where the pair found the tag `already_present` is refused; an add that finds its own tag still present does not block the later removal; a second removal with no write since is refused; the worked example's pair tags a late order and untags it when it ships.

16. **What stays per action.** Cancelling, refunding, price, discount and inventory-quantity changes, fulfilment, customer writes, customer contact outside an approved call plan, supplier mail and anything irreversible stay per-action proposals (ADR-0011 Q4), drafted by code or a run and approved by a person, alone or in a batch. ADR 0042's call plan is the one exception (item 15). No outcome cancels an order by itself (ADR 0042 item 20). An automatic version of any of them needs its own record after measured results.

17. **Occurrence rows and `admit_bounded_action`** (generalises ADR 0042 item 12's `admit_contact_attempt`).
    - **Occurrence rows** are written only by code, in SQL, as ids: by the subscription's apply step (item 3, from a stored receipt), by the deadline sweep (item 10) and by `fire_due_schedules` (item 9). Each names the policy, the trigger-source revision that wrote it, the subject, its entry (the receipt at which the subject began to match, the time it entered the deadline's condition, or the slot) and a state (`open`, then `consumed`, a refusal code, `skipped_stop` or `expired`). No caller, run or person supplies one.
    - **The definer.** One ids-only definer, executable only by `morrow_runtime_executor`, takes one occurrence row's id and nothing else. (For contact, the occurrence row opens one sequence, and each later attempt is admitted on that sequence's server-held (sequence, attempt number), ADR 0042 item 12's key, with every check below.) In one transaction it:
      - locks the occurrence row and refuses unless it is `open`, was written by the trigger-source revision that the policy's active revision binds, and names a subject of that store; the policy, the action and its parameters come from the row and the active revision, never from the caller;
      - checks the policy is active and its revision and digest current; the installation unpaused and its mandate active;
      - re-runs the authority intersection: the installation owner's current grants, the installation's grants, the mandate, connector scopes, live policy and the approver's current authority;
      - calls `effect_stops_clear` (item 21);
      - checks the caps and, for the subject, that it still meets the policy's subject audience (item 12) on the projection;
      - runs the capability's own checks (contact's are ADR 0042 item 12's, with its stricter keys: one sequence per (store, order, purpose) and one tag write per (sequence, tag));
      - writes the rule action, unique on (policy id, subject, action, entry) across every revision of the policy and of its trigger, so a new revision never repeats an action on an occurrence already admitted; creates its OperationLedger operation with one key for life; and consumes the occurrence row.

    A refusal becomes a closed code on the occurrence row. The gateway then claims the operation, re-checks, re-reads the subject live and re-checks the policy's subject audience on that live read (for a tag removal, also that its pair's write is still the latest recorded write or removal of that tag on that order, and that the tag is present), and refuses with `subject_changed` and writes nothing on a mismatch. Otherwise it applies through the mutation registry (plan row SD13), reads back and audits. A failed or uncertain write is settled by the read, never repeated blind. Steps with timing (contact sequences) run in a `PolicyActionWorkflow`, ADR 0042's `ContactSequenceWorkflow` generalised, which only sleeps and calls this definer. `admit_bounded_action` admits a gateway operation, never a run, and issues no lease (amends ADR-0041 item 7's table by stating so).

    `lab:standing-policies` rows: an occurrence id that no trigger wrote, or one written for another policy, trigger revision or store, is refused; a new revision of the policy or of its trigger cannot repeat an action on an entry already admitted; a forged receipt whose live read fails the policy's predicates is refused at the gateway with nothing written.

18. **Plan bundles** (amends ADR-0024 item 9 and ADR-0011 Q3). One server-built `PlanBundleDocument@1` covers 2 to 50 pending proposals of up to 5 capabilities on one store, for example a reorder's spreadsheet artifact and its product note. It is bound to the actor and a session, valid 5 minutes and consumed once. The rule of each field is the strictest among its members; the phrase lists each capability's count and the summed credit and cash ceilings that the members' digests bind (`approve 3 changes and 1 cancellation for C credits`), which bound what the approval authorizes (Proposal@2, ADR-0011 Q6, kept by ADR-0039) and are not a budget; one bad member refuses all; each member keeps its own digest and approval record.

### E. Stops

19. **Rule controls.** `workspace.rule.pause` (control, `human_only`, not review-required; held by the Owner, Admins and the policy's installation owner) and `workspace.rule.revoke` (control, `human_only`, not review-required; held by the Owner and the installation owner). Agents may only propose them. Resuming is a reviewed `workspace.rule.activate`. Neither reserves or is blocked by credits (ADR-0011 Q8). As ADR-0005 item 1 requires of every stop, each pause or revoke records its reason, writes an audit record and notifies the Owner (and the installation owner, when someone else pressed it). ADR 0042's `contact.rule.pause` and `contact.rule.revoke` stay as the Customer contact domain's ids for the same two actions, served by the same definers.

20. **What a stop covers.** The platform stop (ADR-0022 item 15), the workspace stop (P11.T05), Stop AI work on an installation (`agents.installation.disable`), a connection stop (ADR 0042 item 8), a scope stop (ADR-0025 item 10), a capability or domain stop, and a rule pause or revoke. `contact.stop` covers every capability of the "Customer contact" domain whose effect is `communication` (today `contact.attempt.send` and `contact.test_call.place`, and any added later), not a list, and every action of a `contact_plan` policy, its outcome-map tag writes (`orders.tags.add`) included, as ADR 0042 item 14 says; `effect_stops_clear` knows them by the policy id (item 21). It never blocks the domain's controls, drafts or reads (`contact.rule.propose`, `contact.rule.activate`, `contact.rule.pause`, `contact.rule.revoke`, `contact.stop`, `contact.test_recipients.revise` and `contact.results.read`), since a stop control is never blocked (ADR-0011 Q8). A tag write under any other policy, such as a `morrow-late` policy, is not contact, and `contact.stop` leaves it running.

21. **One shared check: `effect_stops_clear`** (installation, store, capability, policy, connection), one ids-only SQL function, used by `admit_bounded_action`, the contact admission, the gateway's mark-started step, ADR 0042 item 14's call-instruction route, the trigger and occurrence writers of items 5, 9, 10 and 17, and the monitor alerter.
    - **One function, a definer per login.** No login executes the function itself. Each caller's login reaches it through a definer of its own, guarded by `executor_memberships_closed(session_user)`, since each executor login runs only its own definers (ADR-0022 item 8): `morrow_runtime_executor` for the admissions, the writers of items 9, 10 and 17 and the monitor alerter; `morrow_connector_ingress` for item 5's inbox-apply writer, the login under which receipts are applied today (`connector_inbox_apply_v2`); and `morrow_vault_broker` for the gateway's mark-started step and the call-instruction route, which run in the broker (ADR-0022 items 7 and 8).
    - **Ids from server-held rows; the rest derived.** Each caller passes ids from its own locked server-held row (the trigger, occurrence, operation, sequence, attempt or monitor row), never from a request or a model, and passes a capability, a policy and a connection only where its step has them. The connection is the one the caller's own operation, sequence or attempt row names, such as the voice connection of a test call (`contact.test_call.place`), which has no policy (ADR 0042 items 9 and 26). The definer takes no tenant: it derives the tenant from the installation's row, and to the connection passed it adds the connections it derives, the store's Shopify connection and, for a `contact_plan` policy, the channel connections of the policy's active revision. An unknown id, a store or connection outside the installation's tenant, or a policy of another installation or store is not clear: the check fails closed, and the caller refuses as it does for a stop. `stops.test.mjs` rows: an installation of another tenant, an unknown installation, store, policy or connection, another installation's policy and a connection of another tenant each report not clear; a stopped voice connection (a barring notice, a spam flag or `reconnect_needed`) refuses a test call at the mark-started step and in the call-instruction route; a contact stop refuses a call plan's tag write and leaves a `morrow-late` tag policy running; the domain's controls and `contact.results.read` still work during a contact stop.
    - **Triggers during a stop are dropped, not queued.** No trigger row is written for a stopped installation, and an occurrence or row that falls due during a stop ends `skipped_stop` (amends ADR-0024 item 6's "never dropped" for this case only).
    - **Lifting a stop resumes no policy.** As ADR 0042 item 14 says of plans, lifting any stop (the platform, workspace, installation, connection, scope, capability or domain stop) resumes no standing policy by itself: each policy that was active when the stop began stays paused until a person resumes it through a reviewed `workspace.rule.activate`.
    - **No burst on resume.** A resume covers subjects whose triggering event, deadline or slot comes after it. The person resuming may opt older ones in, within the 24-hour replay horizon: code then writes new occurrence rows from SQL (the receipts, the deadline's condition on the projection, or the schedule's subject query) for subjects that still meet the policy's subject audience. A `skipped_stop` row stays ended and is never reopened.
    - P11.T05 lands before any send or order-write switch goes on.

### F. Credits

22. **Code-only work** (amends ADR-0039 items 2(a) and 3, generalising ADR 0042 item 23).
    - **Metered.** A content-free `AutomationUsage@1` ledger per (workspace, store, automation kind, day) counts receipts, reconciled changes, trigger rows, sweeps, rule actions, bulk operations and provider sends, with Shopify's API query-cost points (Shopify's rate-limit measure, not money) and the provider's reported cost. It records use; it limits nothing.
    - **Not charged until rate card v1** prices a kind, and rate card v1 publishes only with the owner's confirmation (ADR-0026 item 5).
    - **Never blocked when time-critical.** Ingestion, reconciliation, projections, stops, deletion handlers and actions under an approved policy never wait on credits. Once priced, they draw when the wallet covers them and are otherwise recorded as Morrow's own cost, as ADR-0041 item 9 does for a cache miss.
    - **Model runs hold credits** as today (ADR-0039, ADR-0041 item 9).
    - **Combined resume** (amends ADR-0039 item 2(d) and ADR-0041 item 9, as OD-2026-10-26-12 amended it). A trigger row waits only on credits (ADR-0039 item 2(d)): no row waits on Morrow's provider spend, whose 80% mark raises an alert to the owner, as Morrow's operator, and pauses nothing, and no per-person cap applies (ADR-0041 item 9 and ADR-0040 items 9 and 12, as OD-2026-10-26-12 amended them). Trigger rows of one installation that wait on credits combine into one run per installation, as the owner answered (question 10), across its subscriptions, schedules, deadline rules and monitors. When a wallet change covers the next hold, one transaction re-checks each waiting row as it merges (its source revision still active, its trigger kind inside the mandate's, the mandate active, `effect_stops_clear`) and ends a row that fails `expired` instead of letting it ride on another's run; the newest passing row takes the others' ids, each with its source revision and kind (up to the 500-id cap, then `overflow` for that source, which the run reads by query), the others end `combined`, and the same transaction admits the newest through `admit_mandate_run`, which checks every source it lists, so no source changes between its re-check and the admission. A `once` schedule's row never combines: it is a run's own follow-through, not a trigger, and resumes on its own as a parked job does (item 9). The combined row still passes the installation's hourly rate (item 3), a count and not money. Installations resume oldest first, as parked jobs do (ADR-0041 item 9). The run a combined row admits holds and draws credits like any run, and like any run it waits only for a send slot among the workspace's 12 model calls in flight, traffic control that never refuses it; it parks on the provider's limit only when Anthropic actually refuses a call (`spend_limit`, ADR-0041 item 8).
    - **Discretionary bulk work,** such as a campaign, holds credits for all its actions at approval and is refused up front if the wallet cannot cover them. None exists at launch; the first comes by its own record.

### G. Keys, data and delivery

23. **Keys.**

    | What | Key or rule |
    | --- | --- |
    | Receipt dedupe | (topic, resource id, `updated_at`); also `X-Shopify-Event-Id` |
    | Event trigger | `ev:<installation>:<subscription>:<window start UTC>` |
    | Schedule trigger | `sched:<schedule id>:<slot UTC>` |
    | Deadline occurrence | `dl:<rule revision>:<subject>:<occurrence>` |
    | Monitor alert | `mon:<installation>:<monitor>:<scope group>:<window>` |
    | Policy occurrence row | unique (policy id, subject, entry); written only by code (item 17) |
    | Rule action | unique (policy id, subject, action, entry) across all revisions; one OperationLedger key for life |
    | Contact (ADR 0042) | one sequence per (store, order, purpose); one attempt per (sequence, attempt number); one tag write per (sequence, tag) |

24. **Data.** Subscriptions, schedules, deadline rules, monitors and policies are trigger-set and rule records; trigger rows, occurrence rows, rule-action logs and the usage ledger hold no content. Their clocks are in the dated note on ADR-0031 item 1 (question 15). An order id tied to an action or a trigger on that order is pseudonymous personal data, as ADR 0042 item 15 treats its digests and logs, so these rows blank their order ids 90 days after the order's date, and at once for the orders a `customers/redact` request lists (plan row SD3); their content-free counts stay 365 days. A contact's per-order outcome lives only in ADR 0042's `customer_contacts` and the classes its item 24 names, never in a generic log. Every new table is FORCE RLS with composite tenant keys, and every sweep lists tenants through a definer and works under each tenant's own context.

25. **Switches and order.** Every switch is committed off: `store-event-triggers`, `schedules-v2`, `deadline-rules`, `monitors`, `standing-policies` and `plan-bundles`, beside ADR 0042's `order-events` and `order-tag-writes`. Each goes on by one reviewed commit after its labs, G9 for every class it writes, G10 for any store write, and operator alerts (plan row SD22) for any switch driven by store events. `order-events` also needs the order-keyed deletion paths (plan rows SD3 and SD4) and Neon's paid plan bought and logged (question 17 (a); the owner bought it on 2026-10-26). `order-tag-writes` also goes on only after ADR 0042's CS2 commits its four CLAUDE.md lines (ADR 0042 item 27), whichever plan row turns it on. `standing-policies`, and `order-tag-writes` for a policy's tags, go on only after plan row SD2 commits question 5's three CLAUDE.md lines, since under CLAUDE.md as it stands an action under a standing policy is not an approved exact proposal. Each of those commits follows the owner's word-for-word confirmation (Approval). The order is in `docs/plan/store-data-foundation-implementation.md`.

## Values

All values are catalogue or policy data, changed only by a new version with its evidence. SQL CHECKs hold only safety ranges. None is money: they are counts, rates, windows and times, non-money safety or rate limits under OD-2026-10-25-4, and credits stay the only budget (ADR-0039, OD-2026-10-26-12).

| Setting | Value |
| --- | --- |
| Batching window (`coalesceSeconds`) | default 300 s for runs, 0 for policies; 0 to 3,600 s |
| Event age (`maxEventAge`) | default 24 hours, the replay horizon; 5 minutes to 24 hours (ADR 0042's COD subscription uses 30 minutes) |
| Runs from triggers per installation (`maxRunsPerHour`) | default 6 an hour; 1 to 60; a row over the rate merges (events, deadlines) or waits (monitors, `once` schedules), oldest first, and is never dropped inside the replay horizon |
| Ids per trigger row | 500, then `overflow` |
| Trigger row life | 24 hours after its window closes |
| Replay horizon | 24 hours |
| Subscription re-list | hourly while a time-critical package is active; otherwise daily |
| Deadline sweep | every 5 minutes per tenant; durations 1 hour to 30 days |
| Monitor window | default 24 hours; at least 1 hour |
| Schedule frequency | at least 15 minutes apart; up to 4 daily times |
| Code-written `once` schedules | at most 20 open per installation; at least 15 minutes ahead; counted in the hourly run rate; never written by a `once` episode; fire only under the mandate revision they were written under; cancelled with their run when a stop, revocation, kill switch, authority failure or the mandate's end ends it, and by any stop over the installation |
| Policy caps (counts, not money) | Owner-set subjects a day, default 200, at most 2,000 |
| Setup review document | the install and up to 3 policies, one phrase, one cool-down |
| Plan bundle | 2 to 50 proposals, up to 5 capabilities, one store |
| Solo cool-down | 300 s (ADR-0011 Q3) |
| Code-only work | metered; not charged until rate card v1 |

## Security invariants touched

One invariant's granularity changes, by owner decision (question 5), with the controls below. None is otherwise weakened.

- **Approvals bound to the exact proposal: the granularity changes.** One approval of an exact policy covers each action inside it. What stays exact: the digest binds the store, installation, mandate, trigger, capability, parameters, content digests, audience, caps, outcome map and expiry; any edit is a new approval; each action is admitted against the active revision's digest and the subject's current state, applied by the gateway and read back (`lab:standing-policies`, `lab:approval-records`).
- **Tenant isolation.** The shop comes only from the verified HMAC; trigger rows, occurrences and actions take only server-held ids; no row, Queue batch or sweep crosses tenants (`lab:tenant-conformance`, `lab:store-events`).
- **The intersection, in code, at each action:** the installation owner's grants, the installation's grants, the mandate, connector scopes, live policy and stops, and the approver's current authority, in `admit_bounded_action` and again at the gateway's mark-started step (`lab:standing-policies`, `lab:agent-authority-workers`).
- **Permission and budget checks in code.** Credits, the only budget, are held and drawn in SQL under the wallet's lock (ADR-0039); predicates, count caps, rates, windows and stops, none of them money, are SQL and code; no model is on any action path (`lab:store-events`, `lab:run-credits`, `stops.test.mjs`).
- **Unknown outcomes reconciled before any retry.** One key per action for life; an uncertain write is settled by the read and never promoted (gateway labs).
- **Credentials only in the broker.** Unchanged; the sync and the reconciler read Shopify only through the broker's fixed documents.
- **Default deny.** Every switch committed off; an unknown topic, predicate, preset, capability or schedule kind is refused; a capability without `standing_policy: eligible` cannot be in a policy, except `contact.attempt.send` under ADR 0042's own approval (`standing_policy: contact_plan`); an eligible capability is never irreversible and never a communication, spend or billable effect (`capabilities.test.mjs`, `edge:check`).
- **Kill switches `human_only`.** Rule pause and revoke need no second approver, and agents only propose them; resuming is reviewed (`stops.test.mjs`).
- **No agent-initiated external effect before P11.** Rule actions are gateway operations only, behind G10.
- **Customer data.** Trigger rows hold no payload text; triggered runs get Level 1 only; `includeFields` keeps unneeded fields out of the webhook path (`lab:shopify-privacy`).
- **Immutable migrations.** Forward only (`migration-history.test.mjs`).
- **Accepted residuals.**
  - A compromised orchestrator could delay or skip occurrences, but cannot add one, bring one forward, repeat one, widen a policy or pass a stop: only code writes occurrence rows, in SQL, from receipts, the projection and slots; admission takes only an occurrence row's id, checks that its trigger revision and subject belong to the policy, consumes it, and re-reads the policy, the subject and the stops in SQL; an action is unique per (policy id, subject, action, entry) across revisions.
  - A compromised connector could drop, replay or forge deliveries. The dedupe keys and the reconciler bound drops and replays, and a replay changes nothing. A forged receipt can at most open an occurrence row: the gateway re-reads the subject live through the broker and re-checks the policy's predicates, so a subject that does not really match is refused with nothing written. A subject that does match may be acted on sooner than a real event would have caused, within the policy's caps.
  - A policy acts on the store as the store is when the action is admitted. A staff edit between admission and apply is caught by the gateway's re-read, which refuses rather than overwrites.
  - A tag can drive the shop's own automations (Shopify Flow, other apps), and Morrow cannot undo what they do. The card warns of it (item 14), `morrow-` tags are the default, and a removal strips only a tag its pair wrote with no removal since (item 15). If staff remove the tag and add the same tag again in between, Morrow cannot tell the two apart, one more reason `morrow-` tags are the default.

## Consequences

- **Agents of every kind share one pipeline.** COD Confirmation, an order-operations agent, the Analyst's watches and the Inventory agent's alerts all use the same subscriptions, schedules, deadlines, monitors and policies. A new agent is a package that declares them (AgentPackage@2), not new plumbing.
- **ADR 0042 gets smaller.** Its order filter, sweep, admission definer, stop check and tag path become cases of this record's general parts; its call plan, templates, region policy and contact checks stay its own.
- **Fewer taps, the same control.** The Owner approves an exact policy once instead of each tag. Irreversible and money effects still need their own approval.
- **Plan documents follow** in plan row SD2, now that the owner has answered: `mvp.md` (the trigger kinds and standing policies in scope), `v1-build-order.md` (PR 21 builds on items 3 to 11), the build plan's lettered children, the dated notes in the records this one amends, and CLAUDE.md's wording after CS2's, once the owner confirms both ADR 0042's lines and this record's, word for word (one message can confirm both).
- **Risks.**
  - Event storms (a bulk import, a sale). Mitigation: windows, the per-installation rate, Queue ingress per verified shop, the per-shop buckets for Shopify's API query cost (a rate limit, not money) and inventory coalescing.
  - Policies that act on stale data. Mitigation: predicates re-checked at admission and the subject re-read live at the gateway.
  - Owners approving a policy they do not fully understand. Mitigation: the plain-words card with an example subject, an estimate of actions a day, caps, and one-tap pause.

## Alternatives considered

- **A proposal for every action.** Exact, but a shop with 200 late orders a day would approve 200 tags a day, and batches stop at 50 of one capability.
- **Copying ADR 0042's call plan for each agent.** Repeats definers, review cards and CLAUDE.md exceptions per agent.
- **A model run for every event.** Cost, latency and an injection path for decisions code can make from closed predicates.
- **Free-text or model-written event filters.** An injection and denial-of-service path; closed predicates cover the audited agents.
- **Queueing triggers during a stop and replaying them on resume.** A burst after resume is exactly what a stop is meant to prevent.
- **Charging code-only work now.** No rate card prices it yet, and an empty wallet would silently drop a time-critical action.
- **Reading the shop's zone once at link.** A shop that moves country would keep firing at the wrong hour.

## Not decided here

- Customer data for agents other than Support (a pseudonymous customer handle, Level 1 customer aggregates, broker-supplied Level 2 fields for code paths), and segmentation in code. A later record amends ADR-0025 item 8, ADR-0031 items 2 and 6 and ADR-0037 item 5.
- Marketing contact, email and staff-messaging service kinds, purchase orders to suppliers, and inventory writes (D11). Each needs its own record.
- Topics and scopes beyond ADR-0025 item 6, per agent, by dated amendment.
- Business contacts on the customer identifier screen (ADR-0041 item 31).

## Owner questions

Each is one item on the decision sheet Q-store-data-foundation, which gives each question with its options, its recommendation and why. Questions 11 to 14 are ADR-0044's, 15 is the note on ADR-0031, and 16 and 17 are operations. The owner answered every one as recommended on 2026-10-26 (OD-2026-10-26-11), and the items named below carry each answer.

1. Store events as triggers for any installed agent, by this record: approved. (items 3 to 6)
2. The trigger values: a 5-minute window, at most 6 runs an hour per installation, 500 ids a row, a 24-hour replay horizon, as catalogue values: approved. (item 5; Values)
3. Deadlines and monitors post alerts built by code; a model runs only to explain or draft, at most once per window: approved. (items 10 and 11)
4. Topics stay those ADR-0025 item 6 already approves; more come only per agent, by dated amendment: approved. (item 3)
5. Standing action policies: one exact approval covers each small, reversible action inside it, with the allowlist of item 15 and the CLAUDE.md change: approved. The CLAUDE.md words are confirmed by the owner before their commit (Approval). (items 12 to 17)
6. Cancelling, refunding, prices, discounts, stock, fulfilment, customer writes, supplier mail and anything irreversible stay per action, ADR 0042's call plans being the one exception under their own approval: approved. (items 15 and 16)
7. Plan bundles: one typed confirmation over pending proposals of several capabilities on one store, under the strictest rule: approved. (item 18)
8. Pause rule and Revoke rule, `human_only`, with no second approver; resuming is reviewed: approved. (item 19)
9. One stop check for every automated path; triggers during a stop dropped; no burst on resume; `contact.stop` covers every contact capability, not a list of three (item 20 says exactly which); P11.T05 before any send or order-write switch: approved. (items 20 and 21)
10. Credits for code-only work: option (a), metered, not charged until rate card v1, never blocking time-critical work, waiting triggers combined, discretionary bulk work held up front. (item 22)

## Approval

This record is Accepted. The owner's message in chat, verbatim, on 2026-10-26 (OD-2026-10-26-11), answering the decision sheet Q-store-data-foundation, which put 17 questions, each with one recommendation:

> recommended, and yes to the paid Neon plan

What it approves: this record as recommended, with each of its owner questions 1 to 10 decided as the sheet recommended. The lead reads "recommended" as every recommendation on the sheet, since each question carried exactly one and the sheet named "approve ADR-0043 and ADR-0044 as recommended" as the form of approval. Among them: store events, deadlines and monitors as triggers for any installed agent, with their windows, rates and replay horizon (questions 1 to 4, items 3 to 11); standing action policies with the allowlist of item 15, and plan bundles (questions 5 to 7, items 12 to 18); Pause rule and Revoke rule, and one stop check with no burst on resume (questions 8 and 9, items 19 to 21); and code-only work metered and not charged until rate card v1 (question 10, item 22). The routine items the sheet did not ask about (the schedule contract and the shop's zone, items 7 to 9) were accepted as written, the sheet having said the owner could say otherwise.

**Review fixes after the answer.** An AI review of the records (separate context, same model family) found defects in the text the owner answered. Its fixes, made the same day after the answer and corrected by the second review below, each narrow or make exact what the owner approved and widen nothing; OD-2026-10-26-11 lists them:

- `contact.attempt.send` is not on item 15's allowlist; ADR 0042's call plan is the one named exception, under its own approval and checks (`standing_policy: contact_plan`).
- `admit_bounded_action` takes only the id of an occurrence row that code wrote, actions are unique across revisions, and the gateway re-checks the predicates on its live read (item 17).
- A schedule acts only on subjects a closed subject query in the policy's digest selects (items 9 and 12).
- Lifting a stop resumes no policy; opting older subjects in writes new occurrence rows from SQL (item 21).
- Code-written `once` schedules are bounded (15 minutes ahead, counted in the hourly rate, a successor episode that inherits taint and read tags, no chains) and listed as an amendment of ADR-0041 items 7 and 20, not as routine (item 9).
- Credits-waiting rows are re-checked one by one as they combine, and a row whose source, mandate or stops fail ends `expired` instead of riding on another's run (item 22). An agent still resumes as one run, as the owner answered: the first round of fixes combined per trigger source instead, which would have resumed an agent with two waiting triggers as two runs and so widened the answer, and the second review below replaced it.
- Order ids in the content-free logs are blanked after 90 days (the dated note on ADR-0031 item 1).
- Smaller fixes: the keys of items 9 and 11, the writers of item 5, titles in alerts rendered from ids, content-free notifications, the tag warning and `already_present`, and ADR-0005's reason, audit and notice for rule controls.

**Second review** (2026-10-27). A second AI review of the recorded text (separate context, same model family) found seven defects. Each fix narrows or makes exact what the owner approved and widens nothing; OD-2026-10-26-11 lists them:

- `contact.stop` covers the domain's `communication` capabilities and every action of a call plan, its tag writes included, as ADR 0042 item 14 approved, and never blocks the domain's controls or reads (item 20).
- `orders.tags.remove` works only through a removal policy paired with the add policy whose tag it removes and approved with it; it removes only a tag its pair wrote, with no removal since. The worked example shows the pair (items 12, 14, 15 and 17).
- Waiting rows combine into one run per installation, as the owner answered, each re-checked as it merges; a `once` row resumes on its own (item 22).
- A run's open `once` schedules end with it when a stop, revocation, kill switch, authority failure or the mandate's end ends it, and with any stop over the installation, and fire only under the mandate revision they were written under (item 9).
- `effect_stops_clear` takes no tenant, derives it, and treats an unknown or mismatched id as not clear (item 21). This fix also dropped its connection input, which the third review below restored, taken only from the caller's own locked row.
- A row over the hourly rate with no ids to merge waits for the next slot, and `maxEventAge` has its default and range (items 3, 5 and 9; Values).
- ADR-0044 keeps a person's own `respondentId` (its item 4).

**Third review** (2026-10-27). A third AI review of the recorded text (separate context, same model family) found five more defects and one optional pointer. Each fix narrows or makes exact what the owner approved and widens nothing; OD-2026-10-26-11 lists them:

- `standing-policies` and `order-tag-writes` wait for the CLAUDE.md commits: ADR 0042's four lines for `order-tag-writes`, whichever row turns it on (ADR 0042 item 27), and question 5's three lines for any policy action (item 25).
- `effect_stops_clear` takes the connection that the caller's own locked operation, sequence or attempt row names, so a stopped voice connection refuses a test call, which has no policy; a connection outside the installation's tenant is not clear; ADR 0042 item 14's call-instruction route is one of its callers (item 21).
- Each login reaches `effect_stops_clear` through a definer of its own: `morrow_runtime_executor`, `morrow_connector_ingress` for the inbox-apply writer, and `morrow_vault_broker` for the broker's mark-started step and call-instruction route (item 21).
- A combined row holds each merged source's revision, kind, ids and `overflow` flag (item 5).
- The plan's lab rows cover a `once` schedule of a finished run cancelled when a stop begins, and a mandate taken over (plan row SD12).

**Checked against credits as the only budget** (2026-10-27). The owner's later decision of 2026-10-26, OD-2026-10-26-12 (credits are the only budget: no cost check-in, an alert to the owner in place of the 80% pause, no per-person caps), and OD-2026-10-25-4 leave no money cap or spend budget in this record, and none was added. Wording only, widening and narrowing nothing: item 22's combined resume now says that a waiting trigger row waits only on credits, never on Morrow's provider spend, and that its run then waits only for a send slot, as ADR-0041 item 9 now reads; the counts, rates, windows and caps say they are not money; "the per-shop Shopify budget" reads as the per-shop buckets for Shopify's API query cost, Shopify's rate limit; and "explicit budgets" for the orchestrator's cron reads as explicit time budgets, as ADR-0038's note means.

**The CLAUDE.md wording.** The answer approves the change to CLAUDE.md that question 5 put. The review found that question 5's text started from CLAUDE.md as it stands today, so it would have overwritten three of ADR 0042's four lines (ADR 0042 question 6) and dropped their exceptions. Those four lines are approved in substance, not word for word: their exact text was added to ADR 0042's sheet after the owner's answer, and it waits for the owner's word-for-word confirmation before ADR 0042's CS2 commits it (OD-2026-10-26-9). The corrected text, built on those lines as CS2 will commit them, is on the sheet under question 5. Because CLAUDE.md's standing rules change only with the owner's own confirmation of the words (OD-2026-10-23-10), the corrected words go back to the owner, and the change lands as its own commit after CS2's once the owner confirms them. The owner can confirm both sets of words, ADR 0042's four lines and these three, in one message.

**Question 17** (the paid database plan) is answered (a), "yes to the paid Neon plan". The owner bought Neon's paid plan in Neon's own console on 2026-10-26. Claude bought nothing; the purchase's line in `docs/evidence/activity-log.md` is recorded in its own change.

**What follows:** the work that depends on this record may merge in the order of `docs/plan/store-data-foundation-implementation.md`, each PR behind its switch, committed off, with its tests and review, once SD2 has written the dated note in each record it amends. Each switch still goes on by one reviewed commit after its labs, gates and evals (item 25).
