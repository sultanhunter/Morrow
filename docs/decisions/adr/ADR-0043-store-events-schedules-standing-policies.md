# ADR-0043 Store events, schedules and standing action policies for installable agents

- Status: Proposed 2026-10-26. Nothing in it is approved. Its owner questions are questions 1 to 10 of Q-store-data-foundation.
- Date: 2026-10-26
- Supersedes: none.
- Amends: each only once the owner approves; listed so that the dated notes can be written when the owner answers (plan row SD2).
  - **ADR-0024** item 1 (a mandate's trigger set may hold store-event subscriptions, deadline rules, monitors and standing policies, each inside the mandate's trigger kinds and grants), item 6 (admission from event, deadline and monitor rows, with batching windows, a per-installation run rate, combined resume when credits return, and rows that fall due during a stop dropped rather than retried) and item 9 (plan bundles: one typed confirmation over pending proposals of several capabilities on one store).
  - **ADR-0011** Q3, through ADR-0024 item 9 (the plan bundle's phrase and its strictest-rule merge) and Q9 (the standing-policy review: an access change merged with the class rule of the policy's capability).
  - **ADR-0025** item 6 (the topics a store subscribes to are the union of its active installations' subscriptions within granted scopes; `includeFields` at source; inventory events combined; deliveries also deduplicated on Shopify's event id; trigger rows written in the inbox-apply transaction).
  - **ADR-0027** item 3 (two drafting tools, `routine.draft` and `rule.draft`, neither with an external effect).
  - **ADR-0031** item 1 (the new classes and clocks, in the proposed dated note in that record, question 15).
  - **ADR-0039** items 2(a), 2(d) and 3 (code-only work metered and not charged until rate card v1, never blocked by credits when time-critical; proactive triggers waiting on credits combined into one run per installation).
  - **ADR-0040** item 12 (a standing request's schedule is `Schedule@1`, in place of its cron subset).
  - **ADR-0041** item 7 (the lease-source table names the trigger kinds `admit_mandate_run` admits from, and states that `admit_bounded_action` issues no lease), item 9 (combined resume of waiting triggers), item 20 (deadlines and monitors as episode triggers) and item 35 (the conditional runtime SQL object, if built, also serves the trigger writers, `admit_bounded_action` and the contact definers).
  - **ADR 0042** (connected services and customer contact, approved by the owner as recommended on 2026-10-26; its records PR, CS2, records the approval with its OD number): item 10 (`ContactRule@1` becomes the first case of `StandingPolicy@1`; "for this capability only" becomes "for the allowlist of item 15 below"), item 12 (`admit_contact_attempt` becomes `admit_bounded_action` with the contact capability's checks), item 14 (stops through one shared check; `contact.stop` covers the whole "Customer contact" domain), item 18 (`OrderEventFilter@1` becomes the predicate set of `StoreEventSubscription@1`; the 5-minute sweep becomes the shared reconciler's orders consumer; order events become a trigger kind for agent runs), item 19 (tag writes under a standing policy, through the gateway's mutation registry), item 23 (its credit rule generalised to all code-only work) and its owner question 17, answered (a) "later, by its own change": this record is that change.
  - **CLAUDE.md**, with the owner's approval of the exact wording (question 5), put to the owner together with ADR 0042's CS2 wording as one change: "Approvals are bound to a digest of the exact proposal" and "Agents change it only through an approved exact proposal" (an action inside an approved exact standing policy).
  - **Contracts:** `StoreEventSubscription@1`, `Schedule@1`, `DeadlineRule@1`, `Monitor@1`, `StandingPolicy@1`, `PlanBundleDocument@1`, `AutomationUsage@1`; `capabilities.json` gains `workspace.rule.propose`, `workspace.rule.activate`, `workspace.rule.pause`, `workspace.rule.revoke`, `orders.tags.remove` and `orders.app_note.set`, and a `standing_policy` field on each capability; the tools of item 13.
  - **Build plan:** lettered children only (`docs/plan/store-data-foundation-implementation.md`).
- Does not change:
  - ADR-0005: every stop stays `human_only` with no second approver, and agents only propose stops. The two rule controls this record adds follow its item 1 exactly.
  - Approval of exact content, and the one gateway that re-checks, applies, reads back and audits.
  - Unknown outcomes are reconciled before any retry and never promoted.
  - Credentials are readable only by the broker. FORCE RLS and server-derived tenancy. Default deny.
  - ADR-0031 item 2 and ADR-0025 item 8: customer data reaches Claude only in Support's runs. A run that a store event, a deadline, a monitor or a schedule starts receives Level 1 data only. Agents that look at individual customers need their own record (Not decided here).
  - ADR-0039: credits are the only spend limit. The counts in this record are safety bounds, not money.
  - ADR-0041: Morrow's own harness, Opus 5.5 for every agent, one run per trigger key, envelopes, parks and check-ins.
  - ADR-0035 items 1 and 2: one environment, and the owner's store is the only real store until launch.
- Implements: the owner's direction of 2026-10-26, given with the approval of ADR 0042, that installable agents such as COD Confirmation run on a foundation that consumes live store data and performs scheduled actions (quoted under Context), under the owner's production-grade rule of the same day (OD-2026-10-26-6).
- Relies on:
  - the gateway (V1-PR03) and the stops of P11.T05;
  - mandates (V1-PR21) and the agent loop (ADR-0041), for model runs only; the code paths run no model;
  - `read_orders` and the order data's deletion path (V1-PR22), and the customer-data deletion base (P09.T05, plan row SD4);
  - webhook ingress (P09.T04), the shared reconciler, projections and the per-shop Shopify budget (plan rows SD5 to SD9);
  - ADR-0044 (collaboration grants), for any agent post or question that a trigger leads to.
- Companion: ADR-0044 (collaboration grants for installed agents), and a proposed dated note on ADR-0031 item 1. Their owner questions share one decision sheet, Q-store-data-foundation.
- Plan: `docs/plan/store-data-foundation-implementation.md`.
- Terms:
  - **Subscription:** one installation's interest in one store topic, with closed predicates (`StoreEventSubscription@1`).
  - **Trigger row:** one server-held row that may admit one mandate run (ADR-0024 item 6) or feed one standing policy. It holds ids and closed codes only.
  - **Window:** the batching period over which one subscription's matching events become one trigger row.
  - **Deadline:** a condition that becomes true when time passes ("unfulfilled for 48 hours"), checked by code over a projection.
  - **Monitor:** a metric computed in SQL compared with a threshold, which posts an alert built by code.
  - **Standing policy:** a person's one exact approval of a small, reversible action that code may then take for each subject a trigger names, within caps (`StandingPolicy@1`). ADR 0042's call plan is its first case.
  - **Subject:** the store record one action is about (at launch, an order).
  - **Occurrence:** one firing of a policy for one subject: the first match of an event, one deadline instance, or one schedule slot.
  - **Code-only work:** steps that run without a model: ingestion, reconciliation, projections, sweeps, rule actions and dispatch.

## In plain words

The owner approved ADR 0042 and asked that COD Confirmation be an agent people install, and that Morrow's foundation be ready for agents that use live store data, such as orders, and do things on a schedule. This record says how any installed agent reacts to what happens in the store, keeps a schedule, and takes small actions without asking every time.

- **Agents can react to the store.** An agent can ask to hear about new or changed orders, products or stock. When something matches, Morrow notes it in a record of its own, never acting on the text Shopify sends, and either starts the agent or runs an approved action in code. Bursts are grouped, so 300 orders in a minute start one job, not 300.
- **Agents can keep time.** Schedules run in your shop's own time zone, read from Shopify, so an Indian shop can say "every day at 9 am" in India time. Clock changes never skip or double a run.
- **Agents can watch deadlines and numbers.** "Tell me when an order has been unfulfilled for 48 hours" and "warn me when a best seller has under 14 days of stock" are checked by code, which posts the alert itself. The AI is only asked to explain or draft something.
- **Small, reversible actions can run on one approval.** You approve the exact action once, for example "tag late orders `morrow-late`, up to 200 orders a day", and code then does it for each order that qualifies, through the same gateway that applies, reads back and records every change. Cancelling, refunding, changing prices, discounts or stock, and messaging customers outside ADR 0042's call plans still need your approval each time.
- **Everything stops at once.** Any stop, and two new controls, Pause rule and Revoke rule, halt these actions at their next step. Nothing that fell due while stopped is done in a burst afterwards.
- **No surprise bills.** Work that runs without AI is counted but not charged until the rate card prices it, and running out of credits never blocks a time-critical action. AI runs still use credits as today.

A worked example, for an order-operations agent that is not built yet:

1. You install it. Its setup guide asks for Shopify's `read_orders` and `write_orders`, then shows one review card: a daily digest at 09:00 in your shop's time zone; a deadline, "unfulfilled for 48 hours"; and a standing policy, "tag those orders `morrow-late`, and remove the tag once they ship, up to 200 a day". You type one phrase.
2. On Wednesday at 10:05 an order placed on Monday at 10:00 is still unfulfilled. Code's deadline check notes it; `admit_bounded_action` checks the policy, the stops and the caps; the gateway adds the tag and reads it back.
3. At 09:00 the next day the agent's scheduled run reads the counts, posts the digest in its area and asks you one question (ADR-0044).
4. You press Stop AI work on Thursday. The orders that become late while it is stopped are not tagged. When you resume, only orders that become late after the resume are tagged, unless you choose to include the earlier ones.

## Context

**The owner's direction.** On 2026-10-26 the owner approved ADR 0042 as recommended, in a message whose first words approve it and are recorded, verbatim and in full, with that record's approval in its CS2. The rest of the message, verbatim:

> this COD confirmation agent will be a installable agent by the user(no need to build the actual agent for now just make sure our foundation is solid enough to support these types of agents which can consumes store live data like orders/customers etc and performa scheduled actions etc.)

Earlier that day the owner set the rule for the foundation: production-grade, with no MVP shortcuts (OD-2026-10-26-6). ADR 0042's question 7 (a) already made COD Confirmation a first-party package that a person installs, and its question 17 (a) left order events as a general trigger for agent runs "later, by its own change".

**What the foundation audit found.** Four read-only audits of 2026-10-26, one for each kind of agent (COD Confirmation; an order-operations agent on schedules, events and deadlines; customer retention; inventory and purchasing), were merged into one gap report. The base design holds: long runs, tenant isolation, key custody, digest-bound approvals and a gateway that writes then reads back. The store-data side is mostly unbuilt, and ADR 0042 builds a pipeline that only COD can use. The parts that need an owner decision are here; the routine parts are rows of the plan.

- **Triggers.** `shopify_event` and `monitor` already exist as trigger kinds, and `admit_mandate_run` admits one run per trigger key (ADR-0024 item 6). Nothing defines which topics may start runs, what a trigger row carries, how bursts are grouped, how many runs an installation may start, how missed events are replayed, how per-order deadlines are checked, or how a monitor alerts without a model run. On `main` the webhook sync registers only `app/uninstalled` and `app/scopes_update`.
- **Schedules.** The shop's zone comes from a closed list of four Canadian zones; nothing reads `shop.ianaTimezone`. Mandate routines carry only daily, weekly or monthly; `StandingRequest@1` has its own cron subset; daylight saving and missed slots exist only as plan text; nothing names the writer of schedule trigger rows.
- **Standing approvals.** The only one is ADR 0042's `ContactRule@1`, "for this capability only". Every other small, reversible action (a tag on a risky order, an app-owned note, a tag removed when an order ships) would be a proposal per order, and batches stop at 50 proposals of one capability. A reorder mixes capabilities, so a solo Owner pays the phrase and cool-down twice. Copying ADR 0042 per agent would repeat its definers, its review card and its CLAUDE.md exception.
- **Stops.** The stop check is written for contact; `contact.stop` lists three capabilities, so a new contact capability would fall outside it; generic rules have no pause or revoke; "no burst on resume" is defined only for contact.
- **Credits.** Model runs hold credits (ADR-0039, ADR-0041 item 9). Code-only steps have no metering and no price, so an empty wallet would either block a time-critical action or let it run uncounted, and triggers waiting on credits could all fire at once when credits return.

**Why it is material.** It changes authority (a standing approval for store writes; new trigger kinds for agent runs), money (credits for code-only work), public contracts and data retention. Each needs the owner's approval before dependent code (CLAUDE.md, ADR-0002). The schedule contract and the shop's zone (items 7 to 9) are routine under ADR-0002 and may start before the owner answers; they are here so that every trigger kind builds on one schedule contract.

## Decision

### A. Ground rules

1. **Code first; the model drafts and explains.** Time-critical and repetitive work (calls, tags, alerts, counts) runs on code paths with no model. A model run starts from a trigger only to explain, draft or decide something a person will see, and it reads store data through fixed broker documents under its installation's grants. Text from a webhook, a product, an order or a provider never selects a tenant, a store, an installation, a plan, a policy, an action or a recipient.

2. **Level 1 only.** A run started by any trigger in this record receives no customer data (ADR-0031 item 2, ADR-0025 item 8). Code paths may use a Level 2 field only as ADR 0042 item 15 allows for the phone: read by the broker at dispatch, never kept or shown. Order ids and order names are not customer data under CLAUDE.md.

### B. Store events

3. **`StoreEventSubscription@1`** (closed, RFC 8785 digest), one row per installation and purpose, revised append-only:
   - **Topic** from a closed list: the topics ADR-0025 item 6 approves (`products/create`, `products/update`, `products/delete`, `inventory_levels/update`, and under `read_orders` only `orders/create`, `orders/updated`, `refunds/create`). Any other topic needs a dated amendment to ADR-0025 items 6 and 7 for the agent that needs it, with a closed minimiser and its scope.
   - **Predicates** from a closed list, evaluated in code on the minimised record, never free-text expressions. Orders: payment class, financial and fulfilment status, a total range in the order's currency, a chosen tag present or absent (from the closed set of tags the Owner picks), source, age. ADR 0042's COD test is one predicate (`payment_class = cod`). Products: status, a changed-field class (`title`, `body`, `media`, `price`, `status`), a collection from a list the Owner picks. Inventory: available quantity crosses a threshold, location in a list.
   - **Action**, exactly one: `run` (start a mandate episode), `policy` (feed one standing policy, item 14, with no model), or `monitor` (re-evaluate one monitor, item 11).
   - **Window** (`coalesceSeconds`): 0 to 3,600, default 300 for `run`, 0 for `policy`.
   - **Rate:** at most `maxRunsPerHour` runs per installation from all its event, deadline and monitor triggers together (catalogue value: default 6, at most 60). Schedules are bounded by their own frequency (item 7).
   - **Age:** events whose resource is older than `maxEventAge` are not acted on (ADR 0042's 30-minute transactional window is one value).
   - **Who sets it.** A subscription is a trigger-set revision (ADR-0024 item 1): a run may draft one with `routine.draft` under `workspace.routine.configure`; a person activates it with `workspace.routine.activate` (human_only), inside the mandate's trigger kinds. Its topic's scope must be granted, and the package must declare the topic (AgentPackage@2).

4. **The store's topic set** (amends ADR-0025 item 6). The topics a store subscribes to are its app and compliance topics plus the union of its active installations' subscriptions, limited to granted scopes. The broker's sync lists, then creates or deletes, as reconciled operations, never blind. Each data subscription sets `includeFields` to exactly its minimiser's fields, so fields Morrow never keeps (a phone, an address, a note) are not sent at all. Deliveries are deduplicated on `X-Shopify-Event-Id` as well as the webhook id. Topics with no customer data go through a Queue after the HMAC check (plan row SD6); inventory events are combined to the latest per (item, location, `updated_at`).

5. **Trigger rows** (amends ADR-0024 item 6).
   - Written only in the inbox-apply transaction that stores the minimised receipt, or by the shared reconciler's synthetic receipt (item 6), never by any other path.
   - A row holds ids and closed codes only: tenant, store, installation, subscription revision, topic, window start, up to 500 resource ids with an `overflow` flag (the run then reads by query), and a count. No payload text.
   - One row per window, keyed `ev:<installation>:<subscription>:<window start UTC>`, unique. The first matching event opens the window; later matches add their ids.
   - Over the installation's hourly rate, a closed window merges into the next one the rate allows, keeping every id; nothing is dropped inside the replay horizon (24 hours).
   - `admit_mandate_run` admits the run (ADR-0024 item 6, as ADR-0039 amended it): mandate, trigger kind, the subscription revision still active, quiet hours (the row waits until they end), stops, credits, one run per trigger key. The run reads the named records through fixed documents under its own grants and is tainted by what it reads, as today.
   - A row expires 24 hours after its window closes.

6. **Missed events.** One shared reconciler per (store, resource family) keeps a durable high-water mark on `updated_at` with an overlap, and writes synthetic receipts through the same minimiser and the same dedupe key (topic, resource id, `updated_at`) as real deliveries, so every consumer (projections, trigger rows, policies, ADR 0042's contact sequences) sees each change exactly once, and an older `updated_at` never overwrites a newer one. Subscriptions are re-listed hourly while a package marked time-critical is active, otherwise daily. The reconciler is routine (plan row SD7); this item makes it the only replay path for triggers.

### C. Schedules, deadlines and monitors

7. **`Schedule@1`**, one contract for mandate routines, standing requests (amends ADR-0040 item 12), reports and policy triggers:
   - **Kinds:** `daily` (up to 4 local times, on 5-minute marks), `weekly` (days of the week and one time), `monthly` (a day 1 to 28 or `last`, and one time), `every` (15, 30 or 60 minutes, or 2, 3, 4, 6 or 12 hours) and `once` (one UTC instant, written only by code, item 9).
   - **Zone:** an IANA name. **Missed slots:** `skip` or `run_latest_once` (reports use `run_latest_once`). **Optional** start and end dates.
   - **Daylight saving:** a local time that does not exist fires at the next valid minute; a repeated hour fires once, at its first occurrence.
   - Nothing runs more often than every 15 minutes.

8. **The shop's time zone, from Shopify.**
   - The broker reads `ianaTimezone` in the ShopIdentity document at link, at reconnect and in the daily health read. The full IANA list replaces the four Canadian zones, with an Owner override.
   - Every schedule stores its zone. A change of the shop's zone never moves a schedule silently: it raises one Inbox item for the Owner and each schedule's owner, "Your shop's time zone changed to Asia/Kolkata. Move 3 schedules?", and each schedule moves only on a person's tap.
   - **Which zone applies where:** customer contact uses its region policy's zone (ADR 0042 item 13); mandate routines, reports, deadlines and monitors use the shop's zone; a standing request uses the shop's zone unless its signer picks their own; notifications use each person's quiet hours.

9. **Firing schedules.** One ids-only definer, `fire_due_schedules`, executable only by `morrow_runtime_executor`, writes one trigger row per (schedule owner, slot), keyed `sched:<routine>:<slot UTC>`, unique. It is called per tenant from the orchestrator's cron under explicit budgets (ADR-0038's consequence note), or through ADR-0041 item 35's object if staging shows the distance problem. A run's follow-through beyond its envelope (ADR-0041 item 17) becomes a `once` schedule that code writes under the mandate, at most 20 open per installation; a model never writes one directly.

10. **Deadlines: `DeadlineRule@1`.**
    - A closed condition preset over a projection (plan row SD9): `unfulfilled_for`, `unpaid_for` (a pending manual payment, such as COD), `tag_present_for`, `cancel_requested_unresolved_for`; a duration from 1 hour to 30 days; item 3's predicates to narrow it; and an action: `run`, `policy` or `alert`.
    - A per-tenant SQL sweep every 5 minutes writes one row per (rule revision, subject, occurrence), keyed `dl:<rule revision>:<subject>:<occurrence>`, unique. A subject that leaves the condition and enters it again opens the next occurrence.
    - For `run`, due rows in one window combine into one trigger row per installation, as in item 5. For `policy`, each row is one occurrence. For `alert`, item 11's alert rule applies.
    - A rule refuses to activate (`projection_incomplete`) until the projection covers the store's last 60 days (plan row SD8).

11. **Monitors: `Monitor@1`.**
    - A metric from a closed list, computed in SQL in the shop's zone (`stock_cover_days`, `sales_velocity`, `inventory_available`, `unfulfilled_count`, `refund_rate`), a comparison and threshold, a scope (products, variants or locations from a list the Owner picks, or all), and an evaluation schedule or subscription.
    - **Code posts the alert.** When the condition holds, code writes at most one alert per (monitor, scope group, window), keyed `mon:<installation>:<monitor>:<window>`: an Inbox item for the installation's owner and a system post in the agent's area conversation, built from a template with counts, ids and the titles the viewer may see. A thousand inventory events give one alert per window.
    - **Actions:** `alert`, or `alert_and_run`, which also writes one trigger row per window for a mandate episode that explains the alert or drafts a proposal. A model run never decides whether to alert.
    - Default window 24 hours, at least 1 hour.

### D. Standing action policies

12. **What a standing policy is.** `StandingPolicy@1` is closed and digested with RFC 8785. Its digest binds:
    - the store, the installation and its mandate revision;
    - its trigger: one subscription revision, deadline rule revision or schedule;
    - one capability from item 15's allowlist, with its exact parameters (a tag from a closed list, a note template and its closed variables);
    - per-capability content digests (for contact, ADR 0042 item 10's templates, renderer, voices and segments);
    - the subject audience: the trigger's predicates, which the subject must still meet when the action is admitted;
    - caps: subjects per day (Owner-set at approval, default 200, at most 2,000), actions per subject per occurrence, and optional hours;
    - an outcome map, for capabilities with steps (contact);
    - an optional holdout share (ADR 0042 item 25's method, generalised as `Holdout@1`);
    - an expiry no later than its mandate's.

    The model writes none of the content: `rule.draft` picks presets and list values, and code fills the rest. Person-only fields (caps above their defaults, a holdout above its default, any field ADR 0042 item 10 names) are set only on the review card.

13. **The tools** (amends ADR-0027 item 3). `routine.draft` writes a draft schedule, subscription, deadline rule or monitor from closed presets (`workspace.routine.configure`); `rule.draft` writes a draft standing policy (`workspace.rule.propose`). Neither has an external effect, grants anything, names a recipient, a URL or a credential, or sets a person-only field (`tool-catalogue.test.mjs`). ADR 0042's `contact.rule.draft` becomes the contact form of `rule.draft`.

14. **Approval and life.**
    - **Who.** Activation is `workspace.rule.activate` (control, `human_only`, review-required), reviewed as an access change merged field by field with the class rule of the policy's capability, taking the stricter value (amends ADR-0011 Q9). Any policy whose capability changes the store or contacts anyone needs the Owner as requester or approver (as ADR-0037 item 5 does for cards). In a team, ADR-0024 item 2 and its owner question 1 (b) apply.
    - **The card** shows the policy in plain words, the trigger, the action and its exact parameters, an example subject (an order number and total, never a customer's details), the caps, the estimate of actions a day from the last 30 days, the undo path, and what is never done.
    - **The phrase** is exact: `approve <action> for up to D <subjects> a day`, for example `approve tagging up to 200 orders a day`. A solo Owner waits out the 300-second cool-down and may cancel.
    - **At setup**, one review document holds the install with its mandate and its first policies, up to 4 digests, under one phrase and one cool-down, generalising ADR 0042 item 10's setup document. Each digest stays its own: an edit to any is a new document.
    - **Life.** A policy ends with its mandate (one renewal card covers both), its installation, a lost grant or scope (ADR-0025 item 10), a lost connection (ADR 0042 item 8), or the end of its approver's membership. Any edit is a new revision that needs a new approval; until it passes, the old revision keeps running or pauses, as the editor chose. An action is admitted only under the active revision, and its row records the digest it ran under.

15. **The allowlist: reversible and bounded only.** A capability may carry `standing_policy: eligible` in `capabilities.json` only if its effect can be undone by a person, has fixed parameters, moves no money and changes no stock, price, discount, fulfilment, customer record or cancellation. At first:
    - `orders.tags.add` (ADR 0042 item 19): one tag from a closed list, only tags that start `morrow-` or that the Owner picks at approval; `tagsAdd`, never replacing the order's tags;
    - `orders.tags.remove`: only a tag this policy added, for example when an order ships;
    - `orders.app_note.set`: a note in the app-owned `$app` metafield namespace from a template with closed variables, never the merchant's own order note;
    - `contact.attempt.send` under ADR 0042, whose call plan is this record's first case, with its own checks (region policy, suppression, per-number caps, settled earlier attempts, holdout).

    Each further capability enters the list only by a dated amendment to this record.

16. **What stays per action.** Cancelling, refunding, price, discount and inventory-quantity changes, fulfilment, customer writes, supplier mail and anything irreversible stay per-action proposals (ADR-0011 Q4), drafted by code or a run and approved by a person, alone or in a batch. No outcome cancels an order by itself (ADR 0042 item 20). An automatic version of any of them needs its own record after measured results.

17. **`admit_bounded_action`** (generalises ADR 0042 item 12's `admit_contact_attempt`). One ids-only definer, executable only by `morrow_runtime_executor`, takes (policy, revision, subject, action, occurrence) and, in one transaction:
    - checks the policy is active and its revision and digest current; the installation unpaused and its mandate active;
    - re-runs the authority intersection: the installation owner's current grants, the installation's grants, the mandate, connector scopes, live policy and the approver's current authority;
    - calls `effect_stops_clear` (item 21);
    - checks the caps and, for the subject, that it still meets the trigger's predicates on the projection;
    - runs the capability's own checks (contact's are ADR 0042 item 12's);
    - allows one row per (policy revision, subject, action, occurrence), unique, and creates its OperationLedger operation with one key for life.

    A refusal becomes a closed code on the occurrence. The gateway then claims the operation, re-checks, re-reads the subject live, applies through the mutation registry (plan row SD13), reads back and audits. A failed or uncertain write is settled by the read, never repeated blind. Steps with timing (contact sequences) run in a `PolicyActionWorkflow`, ADR 0042's `ContactSequenceWorkflow` generalised, which only sleeps and calls this definer. `admit_bounded_action` admits a gateway operation, never a run, and issues no lease (amends ADR-0041 item 7's table by stating so).

18. **Plan bundles** (amends ADR-0024 item 9 and ADR-0011 Q3). One server-built `PlanBundleDocument@1` covers 2 to 50 pending proposals of up to 5 capabilities on one store, for example a reorder's spreadsheet artifact and its product note. It is bound to the actor and a session, valid 5 minutes and consumed once. The rule of each field is the strictest among its members; the phrase lists each capability's count and the summed credits and cost (`approve 3 changes and 1 cancellation for C credits`); one bad member refuses all; each member keeps its own digest and approval record.

### E. Stops

19. **Rule controls.** `workspace.rule.pause` (control, `human_only`, not review-required; held by the Owner, Admins and the policy's installation owner) and `workspace.rule.revoke` (control, `human_only`, not review-required; held by the Owner and the installation owner). Agents may only propose them. Resuming is a reviewed `workspace.rule.activate`. Neither reserves or is blocked by credits (ADR-0011 Q8). ADR 0042's `contact.rule.pause` and `contact.rule.revoke` stay as the Customer contact domain's ids for the same two actions, served by the same definers.

20. **What a stop covers.** The platform stop (ADR-0022 item 15), the workspace stop (P11.T05), Stop AI work on an installation (`agents.installation.disable`), a connection stop (ADR 0042 item 8), a scope stop (ADR-0025 item 10), a capability or domain stop, and a rule pause or revoke. `contact.stop` covers every capability in the "Customer contact" domain, not a list of three.

21. **One shared check: `effect_stops_clear`** (tenant, installation, capability, connection), an ids-only definer used by `admit_bounded_action`, the contact admission, the gateway's mark-started step, the trigger writers of items 5, 9 and 10, and the monitor alerter.
    - **Triggers during a stop are dropped, not queued.** No trigger row is written for a stopped installation, and an occurrence or row that falls due during a stop ends `skipped_stop` (amends ADR-0024 item 6's "never dropped" for this case only).
    - **No burst on resume.** A resume covers subjects whose triggering event, deadline or slot comes after it, unless the person resuming opts older ones in, within the 24-hour replay horizon.
    - P11.T05 lands before any send or order-write switch goes on.

### F. Credits

22. **Code-only work** (amends ADR-0039 items 2(a) and 3, generalising ADR 0042 item 23).
    - **Metered.** A content-free `AutomationUsage@1` ledger per (workspace, store, automation kind, day) counts receipts, reconciled changes, trigger rows, sweeps, rule actions, bulk operations and provider sends, with the Shopify cost points and the provider's reported cost.
    - **Not charged until rate card v1** prices a kind, and rate card v1 publishes only with the owner's confirmation (ADR-0026 item 5).
    - **Never blocked when time-critical.** Ingestion, reconciliation, projections, stops, deletion handlers and actions under an approved policy never wait on credits. Once priced, they draw when the wallet covers them and are otherwise recorded as Morrow's own cost, as ADR-0041 item 9 does for a cache miss.
    - **Model runs hold credits** as today (ADR-0039, ADR-0041 item 9).
    - **Combined resume** (amends ADR-0039 item 2(d) and ADR-0041 item 9). Trigger rows of one installation that wait on credits combine into one row when the wallet covers the next hold: the newest row takes the older rows' ids (up to the 500-id cap, then `overflow`), and the older rows end `combined`. Installations resume oldest first.
    - **Discretionary bulk work,** such as a campaign, holds credits for all its actions at approval and is refused up front if the wallet cannot cover them. None exists at launch; the first comes by its own record.

### G. Keys, data and delivery

23. **Keys.**

    | What | Key or rule |
    | --- | --- |
    | Receipt dedupe | (topic, resource id, `updated_at`); also `X-Shopify-Event-Id` |
    | Event trigger | `ev:<installation>:<subscription>:<window start UTC>` |
    | Schedule trigger | `sched:<routine>:<slot UTC>` |
    | Deadline occurrence | `dl:<rule revision>:<subject>:<occurrence>` |
    | Monitor alert | `mon:<installation>:<monitor>:<window>` |
    | Rule action | unique (policy revision, subject, action, occurrence); one OperationLedger key for life |

24. **Data.** Subscriptions, schedules, deadline rules, monitors and policies are trigger-set and rule records; trigger rows, occurrences, rule-action logs and the usage ledger are content-free. Their clocks are in the proposed dated note on ADR-0031 item 1 (question 15). Rows keyed by order are deleted or blanked by the orders a `customers/redact` request lists (plan row SD3). Every new table is FORCE RLS with composite tenant keys, and every sweep lists tenants through a definer and works under each tenant's own context.

25. **Switches and order.** Every switch is committed off: `store-event-triggers`, `schedules-v2`, `deadline-rules`, `monitors`, `standing-policies` and `plan-bundles`, beside ADR 0042's `order-events` and `order-tag-writes`. Each goes on by one reviewed commit after its labs, G9 for every class it writes, G10 for any store write, operator alerts (plan row SD22) for any switch driven by store events, and the owner's answer on the database plan (question 17) before order events. The order is in `docs/plan/store-data-foundation-implementation.md`.

## Values

All values are catalogue or policy data, changed only by a new version with its evidence. SQL CHECKs hold only safety ranges.

| Setting | Value |
| --- | --- |
| Batching window | default 300 s for runs, 0 for policies; 0 to 3,600 s |
| Runs from triggers per installation | default 6 an hour; 1 to 60 |
| Ids per trigger row | 500, then `overflow` |
| Trigger row life | 24 hours after its window closes |
| Replay horizon | 24 hours |
| Subscription re-list | hourly while a time-critical package is active; otherwise daily |
| Deadline sweep | every 5 minutes per tenant; durations 1 hour to 30 days |
| Monitor window | default 24 hours; at least 1 hour |
| Schedule frequency | at least 15 minutes apart; up to 4 daily times |
| Code-written `once` schedules | at most 20 open per installation |
| Policy caps | Owner-set subjects a day, default 200, at most 2,000 |
| Setup review document | the install and up to 3 policies, one phrase, one cool-down |
| Plan bundle | 2 to 50 proposals, up to 5 capabilities, one store |
| Solo cool-down | 300 s (ADR-0011 Q3) |
| Code-only work | metered; not charged until rate card v1 |

## Security invariants touched

One invariant's granularity changes, by owner decision (question 5), with the controls below. None is otherwise weakened.

- **Approvals bound to the exact proposal: the granularity changes.** One approval of an exact policy covers each action inside it. What stays exact: the digest binds the store, installation, mandate, trigger, capability, parameters, content digests, audience, caps, outcome map and expiry; any edit is a new approval; each action is admitted against the active revision's digest and the subject's current state, applied by the gateway and read back (`lab:standing-policies`, `lab:approval-records`).
- **Tenant isolation.** The shop comes only from the verified HMAC; trigger rows, occurrences and actions take only server-held ids; no row, Queue batch or sweep crosses tenants (`lab:tenant-conformance`, `lab:store-events`).
- **The intersection, in code, at each action:** the installation owner's grants, the installation's grants, the mandate, connector scopes, live policy and stops, and the approver's current authority, in `admit_bounded_action` and again at the gateway's mark-started step (`lab:standing-policies`, `lab:agent-authority-workers`).
- **Permission and budget checks in code.** Predicates, caps, rates, windows, credits and stops are SQL and code; no model is on any action path (`lab:store-events`, `stops.test.mjs`).
- **Unknown outcomes reconciled before any retry.** One key per action for life; an uncertain write is settled by the read and never promoted (gateway labs).
- **Credentials only in the broker.** Unchanged; the sync and the reconciler read Shopify only through the broker's fixed documents.
- **Default deny.** Every switch committed off; an unknown topic, predicate, preset, capability or schedule kind is refused; a capability without `standing_policy: eligible` cannot be in a policy (`capabilities.test.mjs`, `edge:check`).
- **Kill switches `human_only`.** Rule pause and revoke need no second approver, and agents only propose them; resuming is reviewed (`stops.test.mjs`).
- **No agent-initiated external effect before P11.** Rule actions are gateway operations only, behind G10.
- **Customer data.** Trigger rows hold no payload text; triggered runs get Level 1 only; `includeFields` keeps unneeded fields out of the webhook path (`lab:shopify-privacy`).
- **Immutable migrations.** Forward only (`migration-history.test.mjs`).
- **Accepted residuals.**
  - A compromised orchestrator could delay or skip occurrences, but cannot add one, bring one forward, widen a policy or pass a stop: admission re-reads the policy, the subject and the stops in SQL.
  - A compromised connector could drop or replay deliveries; the dedupe keys and the reconciler bound it, and a replay changes nothing.
  - A policy acts on the store as the store is when the action is admitted. A staff edit between admission and apply is caught by the gateway's re-read, which refuses rather than overwrites.

## Consequences

- **Agents of every kind share one pipeline.** COD Confirmation, an order-operations agent, the Analyst's watches and the Inventory agent's alerts all use the same subscriptions, schedules, deadlines, monitors and policies. A new agent is a package that declares them (AgentPackage@2), not new plumbing.
- **ADR 0042 gets smaller.** Its order filter, sweep, admission definer, stop check and tag path become cases of this record's general parts; its call plan, templates, region policy and contact checks stay its own.
- **Fewer taps, the same control.** The Owner approves an exact policy once instead of each tag. Irreversible and money effects still need their own approval.
- **Plan documents follow** when the owner answers (plan row SD2): `mvp.md` (the trigger kinds and standing policies in scope), `v1-build-order.md` (PR 21 builds on items 3 to 11), the build plan's lettered children, and CLAUDE.md's wording.
- **Risks.**
  - Event storms (a bulk import, a sale). Mitigation: windows, the per-installation rate, Queue ingress per verified shop, the per-shop Shopify budget and inventory coalescing.
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

Each is one item on the decision sheet Q-store-data-foundation, which gives each question with its options, its recommendation and why. Questions 11 to 14 are ADR-0044's, 15 is the note on ADR-0031, and 16 and 17 are operations.

1. Store events as triggers for any installed agent, by this record. *Recommended: yes.* (items 3 to 6)
2. The trigger values: a 5-minute window, at most 6 runs an hour per installation, 500 ids a row, a 24-hour replay horizon. *Recommended: as written, as catalogue values.* (item 5; Values)
3. Deadlines and monitors post alerts built by code; a model runs only to explain or draft, at most once per window. *Recommended: yes.* (items 10 and 11)
4. Topics stay those ADR-0025 item 6 already approves; more come only per agent, by dated amendment. *Recommended: yes.* (item 3)
5. Standing action policies: one exact approval covers each small, reversible action inside it, with the allowlist of item 15 and the CLAUDE.md wording on the sheet. *Recommended: yes.* (items 12 to 17)
6. Cancelling, refunding, prices, discounts, stock, fulfilment, customer writes and supplier mail stay per action. *Recommended: yes.* (item 16)
7. Plan bundles: one typed confirmation over pending proposals of several capabilities on one store, under the strictest rule. *Recommended: yes.* (item 18)
8. Pause rule and Revoke rule, `human_only`, with no second approver; resuming is reviewed. *Recommended: yes.* (item 19)
9. One stop check for every automated path; triggers during a stop dropped; no burst on resume; `contact.stop` covers the whole domain; P11.T05 before any send or order-write switch. *Recommended: yes.* (items 20 and 21)
10. Credits for code-only work: (a) metered, not charged until rate card v1, never blocking time-critical work, waiting triggers combined, discretionary bulk work held up front; (b) priced per step now. *Recommended: (a).* (item 22)

## Approval

Not approved. This record is Proposed.

Approval is the owner's own statement in chat, quoted here verbatim with its OD number: for example "approve ADR-0043 and ADR-0044 as recommended", or answers by question number. Until then nothing that depends on this record merges, except the routine parts that the plan marks as starting now (items 7 to 9, and the plan rows that need no owner decision). The records PR (plan row SD1) may merge with the record still marked Proposed.
