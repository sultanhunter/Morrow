# Connected services and customer contact: implementation plan

- Record: [ADR-0042](../decisions/adr/ADR-0042-connected-services-and-customer-contact.md) (Proposed 2026-10-26), which answers the owner's question of that day (OD-2026-10-26-8). Its owner questions are on Q-adr-0042-owner-questions.
- Written 2026-10-26 from `origin/main` at `c1709d65`, beside the harness plan (`harness-foundations-implementation.md`, on pull request 82, ADR 0040 and ADR 0041 accepted there) and the v1 build order's PRs 1 to 26.
- Rules (CLAUDE.md):
  - each PR is small, behind a switch committed off, on a short-lived `claude/` branch, with its tests;
  - each PR gets one AI review (separate context, same model family), with the security lens for credentials, provider adapters, authority, RLS, migrations, approvals, budgets and durable execution;
  - stacks are at most two PRs deep;
  - sizes: S is a day or less, M is two to three days, L is a week (usually two PRs).
- Nothing after CS1b starts before the owner answers. CS3 to CS8 do not depend on the agent loop. The contact path (CS8 to CS12) runs no model.
- The rows below assume the recommended answers. A different answer to owner question 4 (the provider), 7 (agent cards), 11 (India's policy mode), 16 (credits) or 17 (order events for every agent) changes the rows it names.

## Order

| # | PR | Size | Starts after | Plan IDs | What it does | Gated by |
| --- | --- | --- | --- | --- | --- | --- |
| CS1 | Records | S | now | none | ADR-0042 as Proposed and its README row; the owner's question as OD-2026-10-26-8; the decision sheet Q-adr-0042-owner-questions; this plan | `npm run verify` (plan and graph checks); one AI review with the security lens |
| CS1b | Sources and graph nodes | S | CS1 | none | `docs/references/connected-services-and-contact.md`: the four research reports' and three reviews' sources, with unconfirmed claims marked; graph feature nodes for connected services, customer contact and order events, and an agent node for COD Confirmation, all `proposed` | `npm run verify` |
| CS2 | Owner answers | S | the owner's answers | none | Each answer verbatim with its OD number; ADR-0042 Accepted; dated amendment notes in ADR-0007, -0011, -0022, -0023, -0024, -0025, -0027, -0030, -0031 and -0035 (and -0037 or -0039 only if questions 7 or 16 are answered (b)); the CLAUDE.md wording the owner approves (the per-send ask, exact approvals and customer data lines); `mvp.md` (a scope row, a cut rule, the "Not at launch" line for person-approved COD cancellations, the Launch agents table); `v1-build-order.md` (lane H, pointing here); the build plan's lettered children (below); `dependencies.json` rows for merchant services and customer contact; `providers.json` rows for the approved entries (design selected, not qualified) | owner approval |
| CS3 | Contracts with fakes | M | CS2 | a P08.T01 child | Generated, closed, no runtime eval: `ServiceIntegration@1`, `ServiceConnection@1`, `CredentialEntryDocument@1`, `ContactRule@1`, `ContactTemplate@1`, `ContactAttempt@1`, `ContactOutcome`, `RegionContactPolicy@1`, `OrderEventFilter@1`; the "Customer contact" domain, nine `contact.*` capabilities and `orders.tags.add` in `capabilities.json`; the tools `contact.rule.draft` and `contact.results.read`; refusal codes; the `service-integrations.json` and `contact-policy.json` schemas; a fake voice provider; `changes.json` | `contracts:generate` clean; `capabilities.test.mjs`; `tool-catalogue.test.mjs` (no tool takes a recipient, number, connection or template text; the draft tool sets no person-only field; results are counts only) |
| CS4 | Service connections: data and vault (security packet) | L (two PRs) | CS3 | a P08.T02 child | Forward migrations: `service_connections`, hashed event and call tokens, health state, entry documents, and the six vault kinds with associated data; the cross-tenant one-account definer; definers for connect, replace and two-phase disconnect under ADR-0011's access-change review (the Owner for communication kinds); the broker's Ed25519 signing key and signed entry documents; `ApiBroker.serviceCredentialSeal` with one-time keys consumed by `DELETE … RETURNING`; fingerprints; deletion handlers (disconnect, uninstall, `shop/redact`, erasure) | `lab:service-connections`, `broker-vault.test.mjs`, `verify:boundaries` (the api never imports or holds plaintext), `lab:tenant-conformance`, `migration-history.test.mjs` |
| CS5 | Sealed entry and the Connected services screen | M | CS4 | a P08.T02 child | The page that checks the broker's signature with the bundled key, then encrypts (WebCrypto ECDH P-256, HKDF, AES-GCM) all fields as one blob; the strict CSP page; Settings › Connected services (summary, India steps, attestations, status, fingerprint, replace with the revoke-at-provider reminder, disconnect) | `workspace-web` tests; `lab:edge-workers` (CSP, no third-party script); a test that the api handler sees only ciphertext; a tampered document is refused in the browser |
| CS6 | Inbound events and call routes (security packet) | M | CS4 | a P08.T03 child | Connector routes `/services/e/:eventToken/:event` and `/services/c/:callToken/:step`, POST only and no query strings; raw bytes to the broker over the service binding, never parsed, logged or enqueued by the connector; token resolution by a connector-only definer; signature and nonce checks per entry; provider-account binding; `hint_then_read` matched to an attempt; deduplication; minimisers to closed enums; 64 KiB; 429 or 503 above the rate; log redaction; receipts for 7 days | `lab:service-events`, `edge:check` (routes pinned), `connector-worker.test.mjs`, `verify:boundaries` (no body parse on `/services/*`) |
| CS7 | Health, limits and reconnect | M | CS4, CS6 | a P08.T03 child | Health checks scheduled from the cron object (ADR-0038), per tenant; states and connection stops; Inbox items; per-connection token buckets and `Retry-After`; reviewed resume | `lab:service-connections` (a refusal leads to `reconnect_needed` and a stop; nothing resumes by itself), `stops.test.mjs` |
| CS8 | Order events | M | CS3; build order PR 22 (`read_orders` and the order data's deletion path) | a P09.T04 child | Minimiser mappings (payment class, source enum, locale list, chosen-tag booleans; no raw strings); the provisional COD test; the Owner's COD and RTO lists built from live reads; `OrderEventFilter@1` in code; the 5-minute missed-order sweep, per tenant; on a development store, how COD orders and their transactions show up, and which protected fields a shipping address's phone needs | `lab:order-triggers`, `lab:shopify-privacy` (still no customer fields kept) |
| CS9 | Call plans and the contact gateway (security packet) | L (two PRs) | CS4, CS8; build order PR 3 (gateway), P11.T05 (stops); PR 21 (mandates) | a P11.T02 child | Plan revisions, the review card's data, the setup document over two digests and its phrase, life tied to the mandate, pause, revoke and `contact.stop`; one plan per (store, order, purpose); `ContactSequenceWorkflow`; `admit_contact_attempt` (settled earlier attempts, SQL-computed times, idempotent); the broker's dispatch transaction under the sequence lock; the region-policy engine with both modes (India only open); suppression across channels; per-number and daily limits; holdout assignment; `customer_contacts` and daily counts; the plan and connection stops; in-flight hang-up and `skipped_stop`; sealed test numbers, test calls, test mode and the `contact-live-recipients` switch | `lab:contact-rules`, `lab:contact-dispatch`, `lab:approval-records`, `stops.test.mjs` |
| CS10 | Plivo voice adapter (India) | L | CS6, CS9 | a P17.T02 child | Its entry record (owner-approved): a sub-account credential, which token signs sub-account callbacks, the regions of media and speech, free-text features off, whether call listings can prove `not_sent`; call creation with per-call tokens and POST answer and hangup addresses; the typed markup builder and the call state machine from approved segments; V3 signature and nonce checks; settling a lost response; no inbound routing; en-IN and hi-IN templates, native-speaker reviewed, with speech quality checked per language | fakes in CI; live qualification on the owner's account and phones only (every key and outcome, a forced lost response, rate limits, the 2-second opening) |
| CS11 | Order tags and cancellation proposals | M | CS9; build order PR 3 | a P11.T02 child | `orders.tags.add` through the gateway with read-back; the tag-write definer per (sequence, tag); the fixed mutation list; `write_orders` requested at setup and revoked when unused; cancellation proposals drafted by code, with "Tell the customer" off by default, approved per order or in batches of 2 to 50; `orderCancel` job follow-through; confirm the scope `tagsAdd` needs | `lab:approval-records`, gateway labs (an uncertain write settled by the read), `lab:group:pg-linking` (capabilities granted and revoked with the scope) |
| CS12 | Customer data path for contact classes | M | CS9; the P09.T05 base (build order PR 25's first customer classes) | a P09.T05 child | Handlers: `customers/redact` by listed orders, then by phone digest; `shop/redact`; erasure; the `data_request` export without digests; suppression kept as a digest; per-order export and erase for the Owner; the 90-day and 365-day clocks; S8 rows; `data-regions.json` "Services you connect" and the changed categories; the Phone field request (owner action) | `lab:retention`, `lab:shopify-privacy` (a phone in no table but as a digest, in no log or event), S8 |
| CS13 | COD Confirmation agent | M | CS9, CS11; the agent loop (harness H7) for its runs; build order PR 21 (mandates) | a P16.T01 child, a P17.T03 child | First-party package `morrow.cod-confirmation` (grants, scopes, the `schedule` trigger, skills, role text); `contact.rule.draft` and `contact.results.read` (counts only) in the loop; the daily exceptions list posted by code; the weekly report; the `EverydayAreaTemplate@1` "Cash on delivery"; holdout statistics in code | `agent-package.test.mjs`, `lab:agent-authority-workers` rows; agent evals (CS15) |
| CS14 | Screens | L | CS3 (against fakes) | a P14.T01 child | The setup guide; the plan review card (rendered script per language, "Call me now", hours and what happens outside them, outcome map, both bills, the phrase); the per-plan log and per-order timeline with the badge table (no phones); the "Calls are paused" banner; the holdout and RTO report; stop and reconnect items in the Inbox; COD cancellation batches in the embedded home's pending approvals | `workspace-web` tests; keyboard and screen-reader checks at phone and desktop widths |
| CS15 | Evals and measurement | M | CS9 to CS13 | none | Agent eval cases (drafting, injection through product titles and posts, person-only fields, report numbers equal SQL); provider qualification scripts; holdout analysis checks; thresholds set before each round | `agent-evals.test.mjs`; live rounds under ADR-0035 on test numbers |
| CS16 | Switches on | S each | everything each switch needs; G10; G9 from `contact-rules` on | none | One reviewed commit per switch, in this order: `service-connections`; `service-entry:plivo-in`; `contact-test-calls`; `order-events`; `contact-rules` (test mode); `order-tag-writes`; then `contact-live-recipients` only with the owner's OK in chat | each switch's labs and qualification; the activity log line |

CS3, CS4 and CS14 (against fakes) can start in parallel once CS2 lands. The security packets (CS4, CS6, CS9, CS10, CS11 and CS12) get full packet treatment; the rest use one-page briefs.

## Plan documents this changes (in CS2)

- **`build-plan.md`**, lettered children only; packages, parent task IDs and acceptance IDs stay. The letters are assigned in CS2 after each parent's last letter:
  - P08.T01: the contact and service contracts;
  - P08.T02: service connections, sealed entry and the vault kinds; the Connected services screen;
  - P08.T03: service events, call routes, health and limits;
  - P09.T04: order event mappings, the COD test and the sweep;
  - P09.T05: the contact classes' deletion path and the Phone field;
  - P11.T02: call plans and dispatch bound to a plan; order tags and cancellation proposals;
  - P14.T01: the contact screens;
  - P16.T01: the COD Confirmation package;
  - P17.T02: Plivo voice for India; WhatsApp and Exotel reserved;
  - P17.T03: the COD Confirmation role release.

  Package 17's "communication (provider selection pending)" note names ADR-0042 for customer contact.
- **`mvp.md`:**
  - a scope row, "Connected services and customer contact", built in parallel and live when its gates pass;
  - a cut rule: if CS9 to CS12 are not merged by G17, it becomes the first fast follow and never blocks launch;
  - the "Not at launch" line changes for person-approved COD cancellations (owner question 10);
  - the Launch agents table gains COD Confirmation, marked after its gates.
- **`v1-build-order.md`:** a lane "H. Connected services and customer contact" pointing here. It names what each PR needs from the owner and what it can run in parallel with.
- **`capabilities.json`, `dependencies.json`, `providers.json`, `data-regions.json`, `contact-policy.json`, `service-integrations.json`.**
- **The graph:** CS1b's feature and agent nodes; each PR becomes a milestone node when it starts.

## Owner actions in this plan

1. Answer Q-adr-0042-owner-questions ("recommended", or by number).
2. Say which calling service you use or want, and which WhatsApp provider or BSP the shop uses, if any.
3. For Plivo:
   - an account with the India data region and KYC (certificate of incorporation, GST);
   - a sub-account for Morrow, and a spend limit at Plivo;
   - a number, declared with your operator for automated calls, with any DLT or principal-entity registration the operator or Plivo requires;
   - the KYC name that caller ID shows, matching the shop name the call speaks.
4. In Shopify's developer dashboard for your app: the Phone field (protected customer data), and the `write_orders` scope when asked.
5. Enter each credential yourself through Morrow's sealed form, never in chat. Seal your own phone number as a test number.
6. Try "Call me now"; later, place a few COD test orders on your store with your own phone.
7. Publish the notice text on your store's privacy policy and checkout.
8. Give your OK in chat before real customers are called, and again on the first live day.
9. Before any outside merchant: counsel on India's call classification, sender registration, suppression retention and the other questions of ADR-0042 item 13, and the merchant agreement and contact terms (G16).

## Not in these PRs

Each needs its own record or entry record:

- WhatsApp (after owner question 4), with ADR-0042 item 17's conditions;
- extended calls for outside merchants (after counsel);
- contact capabilities on agent cards (owner question 7 (b));
- order events as a trigger for every agent (owner question 17 (b));
- free-form AI voice conversations;
- merchant-written script wording;
- recording, spoken answers and item names in the script;
- live transfer to the shop;
- automatic cancellation;
- address confirmation, which needs the Address field;
- delivery follow-up calls;
- SMS, courier entries and merchant mailboxes;
- regions other than India.
