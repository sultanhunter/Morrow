# ADR-0042 Connected services and customer contact: services the merchant connects, approved call plans, order events, and a cash-on-delivery confirmation agent

- Status: Proposed 2026-10-26. Nothing in it is approved. It answers the owner's question of 2026-10-26 (OD-2026-10-26-8). Its owner questions are on Q-adr-0042-owner-questions.
- Date: 2026-10-26
- Supersedes: none.
- Amends: each only once the owner approves; listed so the dated notes can be written in CS2. The same list is in the README row, the plan's CS2 and owner questions 6 and 8.
  - **CLAUDE.md, four lines** (owner question 6). The question shows each line's current and proposed text word for word, and a "yes" approves that text as written, as the owner approved ADR-0035's lines (OD-2026-10-23-10); CS2 commits it unchanged.
    1. Security invariants, "Approvals are bound to a digest of the exact proposal. Any edit invalidates them.": one approval of an exact call plan covers each contact and tag write it names, and an edit to a plan is a new revision that needs its own approval while the approved revision keeps running until then (item 10).
    2. Security invariants, "Agents change it only through an approved exact proposal.": tag writes that an approved plan names (item 19).
    3. Provider and live effects, "Ask the owner first, every time: … sending anything to the owner's customers": the owner's one OK in chat before the first live day, then the plan's approval for each contact (items 10 and 26).
    4. Provider and live effects, "Change the owner's store only through Morrow's own flow: the owner approves the exact change in the workspace": the change may be one an approved plan names (item 19).

    The customer-data invariant ("Customer data … never enter before their P09.T05 deletion and privacy path exists") does not change (item 15).
  - **ADR-0035** items 4 (the per-send ask) and 5 ("Agents change the store or message a customer only after the owner approves the exact change. Any edit needs a new approval."), as the CLAUDE.md lines above (owner question 6); items 3 ("customer scopes only with Support") and 7 ("Customer data comes last, with Support"): the Phone field enters for COD Confirmation, still only after its deletion path (owner question 8; item 15).
  - **ADR-0023** decision 1's "Effects" ("Every store change, discount and customer message needs a person's approval of the exact proposal … Automatic apply comes later, by its own ADR") and the two bullets of its "Security invariants that do not change" on exact-digest approval and per-action approval of customer messages, for contacts and tag writes under a plan (owner question 6); decision 8: customer contact beyond approved support replies, only under call plans (item 9). With them, `mvp.md`'s "never … message a customer without a person approving the exact change" and its "Not at launch" entries "Automatic apply" and "cancellations, order edits", for plan-driven tags and person-approved COD cancellations (owner questions 6, 9 and 10).
  - **ADR-0007** item 4 and **ADR-0022** item 7: merchant service credentials and the contact keys enter the broker vault as new kinds, only through sealed entry, and the broker holds the entry-signing key (items 4 and 5). **ADR-0022** item 7 also: a contact attempt or a plan's tag write takes its input from the plan revision's digest and the system of record, not from a claimed proposal's stored parameters (items 12 and 19). **ADR-0022** item 2: `Operation@2` (see Contracts).
  - **ADR-0011** Q3: the call-plan phrase, and one review document over two digests, the teammate's install and its first call plan, with one phrase and one cool-down (item 21). **ADR-0011** Q4: `contact.attempt.send` joins the irreversible list (item 9). **ADR-0011** Q9: two per-capability overrides, `contact.rule.activate` (control) reviewed as access change merged with communication, and `contact.test_call.place` (communication) in the internal class because its only recipient is the Owner's own test number, proven by a spoken code (items 9, 10 and 26).
  - **ADR-0024** items 1 and 6: a mandate's installation may own call plans, whose attempts only `admit_contact_attempt` admits (item 12). Item 2: the install document also carries the first plan's digest (item 10).
  - **ADR-0025** item 6: the orders minimiser keeps closed mappings of payment, source, locale and chosen tags; `write_orders` joins the optional scopes and is requested during setup (items 18 and 19). Item 7 (store-link template v2): `read_orders` also issues the Owner the `contact.*` capabilities, and `write_orders` issues `orders.tags.add` and `orders.cancel`, each revoked with its scope (item 9). Item 8: Level 2 Phone, read only by the broker at dispatch (item 15).
  - **ADR-0027** item 3: two tools, `contact.rule.draft` and `contact.results.read`. Neither has an external effect (item 21).
  - **ADR-0030** item 9: two recipient kinds, for contact only: the phone on the order, for `contact.attempt.send` (item 11), and the Owner's test numbers once proven, for `contact.test_call.place`, with the fixed verification call that proves them (item 26).
  - **ADR-0031** items 1 to 4, 6 and 7: new classes and clocks, among them the posted exceptions lists and follow-up tasks; redaction by listed orders and keyed phone digest; suppression kept after a customer's redaction request (owner question 13); a customer-class read tag `contact.results.read`; and a "Services you connect" section in `data-regions.json` (items 16 and 24).
  - **ADR-0040** item 10: its workspace stop also stops code-only contact, and lifting it resumes no call plan (item 14).
  - **Contracts:** `capabilities.json` gains a domain "Customer contact" with nine `contact.*` capabilities, `orders.tags.add`, and service connections under `governance.connection.connect` and `governance.connection.disconnect`; generated contracts `ServiceIntegration@1`, `ServiceConnection@1`, `CredentialEntryDocument@1`, `ContactRule@1`, `ContactTemplate@1`, `ContactAttempt@1`, `RegionContactPolicy@1` and `OrderEventFilter@1`; `Operation@2` (ADR-0022 item 2): a `contact.attempt.send` operation, and an `orders.tags.add` operation driven by a plan, have no task and no proposal of their own, and bind the plan revision, its activation approval and the sequence instead, which a forward migration admits for these two capabilities only (items 12 and 19); public routes on the connector host (item 7).
  - **Build plan:** lettered children only (`docs/plan/connected-services-implementation.md`).
- Conditional: two more amendments follow only from a non-recommended answer. ADR-0037 item 5 (contact capabilities on agent cards) if owner question 7 is answered (b); ADR-0039 items 2(a) and 3 (contact attempts as paid steps) if owner question 16 is answered (b).
- Does not change:
  - ADR-0005: every stop stays `human_only` with no second approver, and agents only propose stops. The three stop controls this record adds follow its item 1 exactly.
  - Approval of exact content, and the one gateway that re-checks, applies, reads back and audits.
  - Unknown outcomes are reconciled before any retry and never promoted.
  - Credentials are readable only by the broker. FORCE RLS and server-derived tenancy. Default deny.
  - ADR-0031 item 2: customer data reaches Claude only in Support's runs. No phone, name, address or customer message reaches any model because of this record, and agent runs see contact results only as counts (item 21).
  - ADR-0023 decision 6: no package holds both customer data and the computer. The rule extends to contact capabilities.
  - ADR-0029: the sandbox has no internet and no credentials.
  - ADR-0039: credits are the only spend limit. The counts in this record are safety bounds, not money.
  - ADR-0041 (harness foundations): Morrow's own harness, and Opus 5.5 for every agent.
  - ADR-0035 items 1 and 2: one environment, and the owner's store is the only real store until launch.
- Implements: the answer to the owner's question of 2026-10-26 (OD-2026-10-26-8), under the owner's production-grade rule of the same day (OD-2026-10-26-6).
- Relies on:
  - the gateway (v1 build order PR 3), and holds and stops (G10, P11.T05);
  - mandates (build order PR 21);
  - `read_orders` and the order data's deletion path (build order PR 22);
  - the P09.T05 customer path (G9); build order PR 25 brings the first customer classes;
  - webhook ingress (P09.T04) and ADR-0038's cron object;
  - the agent loop (ADR-0041), for the agent's own runs only. The contact path runs no model.
- Plan: `docs/plan/connected-services-implementation.md`.
- Terms:
  - **Connected service:** a merchant's own account at an outside provider, linked to one workspace and store through a catalogue entry.
  - **Entry:** one catalogue entry (`ServiceIntegration@1`): one provider's typed actions and events, and its adapter in the broker.
  - **Connection:** one linked account (`ServiceConnection@1`).
  - **Sealed entry:** a form that encrypts a secret to the broker inside the browser.
  - **Call plan:** the Owner's one exact approval of what may be said, to whom, when and how often. In code it is `ContactRule@1`, and its capabilities are `contact.rule.*`.
  - **Sequence, attempt, outcome:** the contacts for one order under one plan; one call or message; its closed result.
  - **Holdout:** eligible orders that are deliberately not contacted, so the effect can be measured.
  - **COD:** cash on delivery. **RTO:** return to origin, a parcel the customer did not accept.

## In plain words

The owner asked whether a person can create an agent that calls each customer who places a cash-on-delivery order, to confirm it, so that fewer of those orders are cancelled or refused, using a calling service the merchant brings.

**Yes.** You ask for it in your own words, and Morrow sets it up as a teammate. In the first version that teammate is Morrow's own COD Confirmation agent, set up from what you say. For example, for a shop in India:

1. You tell Morrow: "When a cash-on-delivery order comes in, call the customer to confirm it." Morrow shows the COD Confirmation teammate with a setup guide: "0 of 3 done".
2. **Connect your calling service.** The guide lists what to have ready at the provider (your company documents for KYC, an India data region, your numbers registered for automated calls) and how long KYC takes. You paste a key from a sub-account into a sealed form; your browser encrypts it before sending. Morrow checks it and never shows it again.
3. **Allow tagging.** Shopify asks you once to let Morrow tag orders.
4. **Hear it and approve.** You add your own phone as a test number: Morrow calls it once and speaks a 6-digit code, which you type back. Then you tap "Call me now", and your phone rings with the exact words, for a recent real order. You read the call plan: the words in English and Hindi, the calling hours, two tries within 30 minutes, and the tag each answer puts on the order. You type "add COD Confirmation and approve calls for up to 200 COD orders a day".

Then, on a normal day:

- At 2:02 pm a ₹1,499 COD order arrives. At 2:03 the customer's phone rings: "Hello, this is an automated call from your shop about your order 1042 for 1,499 rupees. To confirm, press 1. To cancel, press 2 …". She presses 1, and the order gets the tag `morrow-cod-confirmed` in Shopify.
- Another customer presses 2 twice. That order gets `morrow-cod-cancel-requested`, and its cancellation waits for your OK in the Inbox. You approve several at once.
- A third customer doesn't answer. The call is tried again at 2:14. If nobody answers, the order is tagged `morrow-cod-unconfirmed` and appears on the day's list for you to decide.
- About one COD order in ten is deliberately not called, and gets no tag, so Morrow can measure what the calls change. Every Monday the teammate reports confirmations and cancellations at once, and returned parcels once they are known; it says "Too early to tell" until there are enough orders.

What it never does:

- It never improvises. The words are fixed, and you approve them.
- No agent ever reads or shows a customer's phone number. Only the system reads it, at the moment of dialling.
- It never cancels an order unless you approve.
- It never calls outside calling hours, or after a customer presses 9 to stop.
- It never sells anything on the call.

What comes later: WhatsApp messages, once you tell us which WhatsApp provider you use; calls more than 30 minutes after the order, once a lawyer confirms India's rules; other countries.

When: if you approve, it would be built beside the rest, with its switches off. "Call me now" would work once the gateway and its stops are in place. Real customers would be called only after the customer-data deletion path is in place, Shopify allows the phone field, and you give your OK in chat, once, before the first live day. Other shops come only after a lawyer has confirmed India's calling rules and the merchant agreements exist.

## Context

**The question.** The owner's message in chat on 2026-10-26 (OD-2026-10-26-8), quoted in full:

> lets accept the recommended options, also i want to know one thing since we are building a full fledged ai workspace with people and ai agents teammates to run shopify business will the user able to suppose create a agent for suppose a cod order appears then the agent calls the customers to confirm the cod order so the rate of cancellation decreases(ofcourse all the apis access for the external services that will be provided by the user like the calling service etc.)

Its first part accepted ADR-0040 and ADR-0041 as recommended; that decision is OD-2026-10-26-7, which also quotes the message in full. This record answers its question. It approves nothing.

**What the records say today.** The launch plan does not allow this yet, and nothing in it rules the feature out:

- Outbound customer messages are approved email replies to someone who wrote in (ADR-0023 decision 8; ADR-0030 items 3 and 9). ADR-0040 says "Not taken from dots: calls and text messages".
- Level 2 data is name and email, for Support only. The orders webhook drops the phone (ADR-0025 items 6 and 8). Customer data comes "last, with Support" (ADR-0035 item 7) and lives only on 90-day clocks (ADR-0031 item 2).
- Agent cards never hold Level 2 data or `support.*` (ADR-0037 item 5).
- No tool takes a URL, a recipient or a credential (ADR-0027 item 3).
- A merchant-supplied credential is a new custody path, and each kind needs its own record (ADR-0030 item 10(a); ADR-0007 item 4).
- `write_orders` is not requested, and cancellations are deferred (ADR-0025 item 6; `mvp.md`).
- No telephony, voice, SMS or WhatsApp provider is named anywhere.

**What the research found.** Four reports of 2026-10-26 (technical, legal, platform practice, repository), then three reviews of the draft (security, legal and privacy, product). The four reports' sources are listed in `docs/references/connected-services-and-contact.md`, each with what it supports, and the reviews' findings are in the items below and under "Reviews of the draft". Claims marked unconfirmed stay unconfirmed here.

- **The market and the effect.** Merchants already buy this. IVR apps, WhatsApp-button apps and newer AI-voice apps for COD confirmation are on the Shopify App Store. The common pattern is a call within a minute of the order with "press 1 / press 2", WhatsApp if unanswered, then a tag on the order; the field is moving towards WhatsApp first with a call as fallback. Industry sources put COD RTO at about 24 to 30%, against 2 to 8% for prepaid orders. Vendors claim 15 to 45% fewer RTOs. No independent controlled study was found, so the effect has to be measured, not assumed. Indian COD orders peak in the evening, and Indian stores rarely set a Hindi checkout locale (from the reviews, not yet sourced).
- **Shopify.**
  - The Order object has no COD flag. A Shopify-staff answer (not official documentation) recommends checking the order's transactions for the COD gateway with `manualPaymentGateway` set to true.
  - Phone is a Level 2 field, requested on its own and reviewed for public apps. Whether a shipping address's phone needs the Phone field alone or also the Address field is unconfirmed.
  - `tagsAdd` appends tags, while setting `tags` overwrites them. `orderCancel` needs `write_orders`, runs asynchronously and cannot be undone.
  - Webhooks are retried 8 times over 4 hours and are deduplicated on `X-Shopify-Webhook-Id`. Indian courier aggregators often do not write RTO back to the order's fulfilment status (not yet sourced).
- **Providers and India.**
  - Plivo, citing TRAI, says call media for India must be anchored on servers in India (unconfirmed beyond Plivo's statement).
  - Twilio dials Indian numbers only from non-Indian numbers. Vapi is unsupported for Indian numbers, and numbers bought from Retell dial only the US.
  - Workable stacks are India-anchored telephony: Plivo with an India data region (signed V3 callbacks, call instructions fetched from the app per call), or Exotel (unsigned callbacks, which must be confirmed through its call-details API).
  - Most Indian merchants reach WhatsApp through a Business Solution Provider (BSP) rather than the raw Cloud API (not yet sourced). WhatsApp utility templates with buttons cost roughly ₹0.12 to 0.15 a message, from third-party figures. A template that carries any promotion becomes a marketing template. Meta's Business Messaging Policy requires the recipient's opt-in to WhatsApp messages from the business, and honours opt-outs given "on or off WhatsApp" (from the legal review, not yet sourced).
- **The law, India first.** This is research, not legal advice; counsel confirms it (item 13).
  - TRAI's TCCCPR treats a confirmation call made within 30 minutes of the transaction as a transactional call, which needs no explicit consent. A service call giving "information regarding delivery of goods" needs none either, but a call that "facilitates a commercial transaction involving the ongoing purchase" needs explicit consent that lasts 7 days. Which of the two a later COD confirmation is remains open.
  - Any promotional content makes the whole call promotional.
  - The 2026 Third Amendment requires automated calls, AI voices included, to be declared with their caller-ID ranges to the operator. Undeclared calls count as spam. Its Gazette date is unconfirmed. Calling-name display (CNAP) shows the KYC name from 1 November 2026.
  - Operators flag senders by how they call, and 3 complaints in 10 days on a flagged number can bar the sender's lines. Schedule IV flags senders above 3% abandoned or 1% silent calls over 24 hours.
  - The DPDP Act's core duties start about 13 May 2027 (a computed date); until then the IT Act's section 43A and the 2011 SPDI Rules apply (from the legal review, not yet sourced). The confirmation call fits section 7(a)'s "legitimate use"; Rule 8(3) sets a minimum of one year of processing logs, for the fiduciary, once in force. A keyed phone digest and an order's contact outcomes are personal data in law, though pseudonymous.
  - Elsewhere: the US treats AI voices as artificial voices (FCC 24-17) and requires the caller's registered name and a callback number. The EU AI Act's Article 50 requires disclosure that the caller is an AI system. In the UK a service message is not direct marketing, but any marketing element makes it marketing.
- **Platform practice.**
  - Credentials stay out of the model and the browser. MCP forbids collecting secrets through a model-visible form.
  - Every action has a closed, typed schema. Irreversible actions are approved by a person.
  - Outbound effects carry idempotency keys and are reconciled; inbound webhooks are verified over the raw body.
  - Call transcripts, webhook payloads and a provider's own AI-written "call analysis" are all untrusted. The design-pattern literature (action-selector, plan-then-execute) says untrusted input must have no path to consequential actions.

**Why it is material.** It touches external messages and real customer data; authority (a standing approval); security (credential custody and new public endpoints); provider selection; public contracts; data retention; and possibly money. Each needs the owner's approval before dependent code (CLAUDE.md, ADR-0002).

## Decision

### A. Roles and connected services

1. **Roles** (owner question 18).
   - For each contact, the merchant is the sender (TCCCPR's principal entity), the data fiduciary (DPDP) and the controller (GDPR). Morrow is the merchant's processor. The connected provider is the merchant's own processor, under the merchant's own contract.
   - Morrow uses contact data for no purpose of its own: no cross-merchant benchmarks, no product analytics beyond aggregate service counts, no model training. Holdout results stay per merchant.
   - Before any outside merchant (G16), counsel drafts and the owner approves: a merchant data processing agreement and contact terms (acceptable use with no promotion on calls, callbacks or replies; the merchant's warranties on notice, opt-ins, number declarations and registrations; the instruction to send data to the merchant's own provider; Morrow's breach notice to the merchant within 24 hours with the facts the merchant needs; deletion; the sub-processor list).
   - **The notice kit.** At setup Morrow gives the merchant ready text for the privacy policy and checkout ("We may call you with an automated system to confirm cash-on-delivery orders. Press 9 to stop these calls."), and records the merchant's attestation that it is published. On the owner's store the owner is both merchant and operator.
2. **What a connected service is.**
   - A merchant's own account at an outside service, linked to one workspace and one store so that agents can use it through typed actions. The merchant holds the account, its contract and its bill. Morrow holds a sealed credential and the adapter.
   - **Only from the catalogue.** Morrow supports a service only through a catalogue entry that Morrow's team builds, reviews and qualifies. A merchant cannot paste an arbitrary API, URL, webhook or MCP server, and no agent can name one. A service that is not in the catalogue becomes a dependency request (build plan P16.T02's rule), never a generic HTTP tool. This is how "the APIs provided by the user" works: the user provides their account, and Morrow provides the reviewed adapter.
   - **Kinds** are a closed enum: `voice_call` (scripted outbound calls) and `whatsapp_business`. Any other kind (SMS, couriers, mailboxes) enters the enum only by its own record.
   - **Each entry is its own decision** (owner question 3). An entry selects a provider, a data flow and a credential kind, which is material. Each comes with a one-page entry record that the owner approves: processor facts, regions (media, speech engines, storage), what Morrow sends, the adapter's guarantees, its least-privilege credential and its qualification evidence. This record proposes the first entry, Plivo voice for India, and the conditions for WhatsApp's (owner question 4).
3. **The catalogue entry and its adapter.**
   - `ServiceIntegration@1` is generated, digest-pinned data in `docs/contracts/service-integrations.json`: id, kind, provider and its API version; regions; the auth method (`api_secret` for the first entries; any other method by its entry record); closed credential fields with formats; base hosts; actions and events; rate limits; the data sent per action; processor facts; a read-only health check; its entry record.
   - **Actions** are typed. Each names its Morrow capability, its effect, closed input fields, its output, its correlation method (`provider_key` or `correlation`), a reconciliation read (or none) and its verification.
   - **Events** are typed. Each names its verification method (`signature` with its scheme, or `hint_then_read`), its dedupe key and its minimiser.
   - **Adapters run only in the broker**, one reviewed module per entry. Hosts are fixed in code per entry, never from data, a provider response or a model. Responses pass through closed decoders; unknown fields are dropped. Provider features that produce free text (AI call analysis, transcription, voicemail transcription) must be off, and qualification asserts that their fields are dropped.
   - **Admission rule** (ADR-0030 item 10(f), generalised). An adapter is admitted only if every effectful action has one key per operation, or a proven guard against a second effect; verification of what was sent; and either a reconciliation read that can prove an operation never ran, or the declaration that `uncertain` is terminal for its channel (item 6). An entry whose content lives at the provider (a WhatsApp template) is admitted only if that content can be checked by digest at dispatch. Live qualification on the owner's own accounts and test numbers (P08.A04, P17.A02) comes before its switch.
4. **Connecting a service** (owner question 2). `governance.connection.connect` and `governance.connection.disconnect` now also cover service connections.
   - **Who.** Connecting is an access change: `governance.connection.connect` (control, `human_only`, review-required), under ADR-0011's access-change review. A service of a communication kind needs the Owner as its requester or approver, as with ADR-0037 item 5's four kinds.
   - **The screen** (Settings › Connected services) shows the entry's plain-words summary: what Morrow sends (for a call: the customer's phone, the order number, the amount and the shop's spoken name); where the provider keeps it; what the merchant must do first (for India: KYC, the India data region, the declaration of item 13, a sub-account, and the provider-side limits the entry record names, such as calls to India only and transfer and recording off); the advice to set a spend limit at the provider; and, for shops whose name reveals a sensitive purchase (health, for example), that whoever answers hears the shop name.
   - **Sealed entry for secrets.**
     1. The api serves a `CredentialEntryDocument@1` that the broker built and signed with its entry-signing key (item 5), naming that key's id. It is bound to the actor, a standalone session, the entry and the draft connection; valid for 5 minutes; consumed once. It carries a single-use public key the broker generated.
     2. The page checks the signature against the verification key with that id compiled into the workspace-web bundle, and refuses a key id it does not know; then it encrypts all credential fields as one JSON blob with WebCrypto (ECDH P-256, HKDF-SHA-256, AES-256-GCM). The associated data is the document id, entry id, draft connection id and actor id. It posts only the ciphertext.
     3. The api relays the ciphertext unread to `ApiBroker.serviceCredentialSeal`.
     4. The broker consumes the one-time private key (`DELETE … RETURNING` under a row lock; item 5), decrypts, validates the formats, seals the credential in the vault and keeps nothing else. Expired keys are purged by cron. The document row never holds the ciphertext.

     The api never holds the plaintext, and its environment mapper still refuses credential bindings. The page loads no third-party script (`default-src 'self'`, `connect-src 'self'`), turns autofill off and clears the field after sending. Sealed entry protects against exposure in the api, and against a compromised api once signed. It does not protect against a compromised web Worker, an XSS bug or a browser extension while the secret is typed; those are accepted residuals.
   - **Least privilege.** The entry record names the narrowest credential. For Plivo it is a sub-account's Auth ID and token; the account check refuses a main account's. Which token signs V3 callbacks for a sub-account's calls is confirmed in the entry record; if it is the parent's, the record says what the restriction then does not cover.
   - **Provider-side limits.** The entry record also names each limit the provider offers that narrows what a stolen credential or a rewritten call can do, and the Owner sets them at the provider. For Plivo, where Plivo offers them (confirmed in the entry record, including whether they apply per sub-account): outbound calls to India only (geo permissions), and call transfer and recording off. The account check and qualification assert each one the provider lets the broker read, and the screen lists any it cannot read as the Owner's to keep.
   - **Account check.** A connection becomes `active` only after the broker's read-only check passes (for a calling service: the account, its region and its numbers). The broker records the provider account id. One provider account may be active in only one workspace and store at a time: a definer enforces one active connection per (entry, provider account) across all tenants and returns a generic refusal. A failed check stores nothing.
   - **Never shown again.** A connection shows its provider, account id, status, the date, who connected it and a short keyed fingerprint, never any character of the secret. Replacing a secret is a new connect with `replaces`; the old vault version is destroyed once the new one passes its check and the attempts in flight under the old one settle, at most 10 minutes later (item 8), and the screen tells the Owner to revoke the old key at the provider, because Morrow cannot.
   - **No account passwords.** A provider that offers only a login password is not admitted. OAuth comes only with an entry record that needs it.
5. **Custody** (amends ADR-0007 item 4 and ADR-0022 item 7).
   - **New vault kinds** in `morrow_vault.credentials`, widened by a forward migration: `service_api_secret`, `service_webhook_secret`, `entry_private_key` (bound to its document id), `contact_digest_key` (per workspace), `contact_test_number` (item 26) and `service_fingerprint_key` (separate from the digest key). Each record is AES-256-GCM under the broker's KEK, with associated data of environment, organization, workspace, connection or document id, entry id, kind and version.
   - Only the broker reads them, and only to make an adapter call, verify an event, compute a digest or dial a test number. They never reach logs, Workflows, Queues, other Workers, a model, the sandbox, an artifact or the browser.
   - **The digest key is never rotated away.** Every version is kept for the workspace's life, and suppression is checked under every kept version.
   - **The entry-signing key.** The Ed25519 private key that signs credential entry documents (item 4) is a broker secret, `SERVICE_ENTRY_SIGNING_KEY`, bound only to the broker (`edge:check`; the api's environment mapper still refuses credential bindings). It is not a vault row. An owner-run script generates the pair into a chmod-600 file under `~/.config/morrow/<env>/` and prints only the public key; the owner places the private key with `wrangler secret put`, never in chat, the repository or a command line. The public key, with its key id, is committed in `docs/decisions/service-entry-keys.json` and compiled into the workspace-web bundle. **Rotation** takes three steps: a web release that accepts the old and the new key ids; the owner places the new private key, and the broker signs with it; a later release drops the old key id. A compromised key is handled the same way, with documents signed by the old id refused once its release lands. Production custody (below) covers this key too.
   - **Scope.** A connection belongs to one workspace and one store. A plan on another store cannot use it.
   - **Production custody.** The production custody record (ADR-0007 item 9, G12) carries these kinds over or decides them again. Until then they serve only the owner's store (ADR-0035).
6. **Outbound: every effect is a gateway operation.**
   - An effectful action runs only for an OperationLedger operation the gateway has claimed, with one key for life. The broker marks it started under a row lock and commits the mark before calling the provider, holding no transaction or lock across the call (as ADR-0022 item 7 and ADR-0030 item 4 do), and refuses a second send. A failed commit places no call. Anything after the mark that does not prove nothing ran is `uncertain`.
   - **Correlation.** Where the provider has an idempotency key, the operation key is used as it. Where it has none, the adapter sends an opaque per-operation token in the field the entry names (for Plivo, a per-call token in the answer and hangup URLs), and reconciles by that token.
   - **Uncertain is terminal in v1.** An uncertain attempt waits for the provider's signed events; any that proves the call happened settles it (item 12). Otherwise it stays `uncertain`, its sequence makes no further contact, and the Owner gets an Inbox item. The harm this prevents is a duplicate call to a customer.
   - **Proving `not_sent`** is allowed only for an entry whose qualification proved its read complete, and then needs all of: a settle delay of at least the ring timeout plus the call's time limit plus the measured lag of the provider's call records; empty results from its queued, live and completed call reads, filtered by the destination (re-read by the broker) and the time window; and no signed callback for the call token. Whether Plivo's listings meet this is confirmed in its entry record; until then the rule above applies.
7. **Inbound events and call routes.**
   - **Routes** on the connector host, public contract additions pinned in `edge:check`: `POST /services/e/:eventToken/:event` for events, and `POST /services/c/:callToken/:step` for call instructions (item 12). A GET verification handshake is added only by an entry that needs one (item 17). Requests with a query string, and GETs elsewhere, are refused, so phone numbers never land in URL logs; the entry sets the provider's answer and hangup methods to POST.
   - **Tokens** have at least 128 bits of entropy, are stored only as SHA-256 hashes, are rotatable, and are resolved by a definer only the connector role may execute. It returns the tenant ids, and the later work runs under that tenant's own context. Path tokens and request bodies are redacted in Workers logs.
   - **The connector never reads the body.** It passes the raw bytes and headers to the broker over the service binding, never through a Queue or a Workflow, and never parses, logs or enqueues them (`verify:boundaries`). Provider callbacks carry the customer's number, so it transits the connector unread, as Shopify's webhook bodies already do (`apps/shopify-connector/worker/webhooks.ts`), `orders/create` among them once `read_orders` is granted; what a compromised connector could do with them is under "Accepted residuals".
   - **Verification before any parse.** In the broker: `signature` events are checked against the entry's scheme with a constant-time compare (for Plivo, the V3 signature with its nonce). The event's provider account id must then equal the connection's recorded one, or it is dropped. `hint_then_read` events (providers without signatures) are hints only: the hinted call id must match an existing attempt of this connection, by recorded id or correlation token, before the broker reads the provider's record; those reads have their own rate limit.
   - **Replays.** Signature nonces are kept per connection for at least the provider's retry window, and reuse is refused. Events are deduplicated on the provider's event key. Call transitions are keyed on (provider call id, step), idempotent under the provider's own retries; a per-call token dies at a terminal state.
   - **Minimised before storage.** A fixed per-event minimiser keeps ids, closed codes, durations and costs. Hangup causes and similar fields map to closed enums, with unknown values as `other`. Never a phone number, a name, a recording URL, free text or provider analysis.
   - **Limits.** Bodies are capped at 64 KiB. Over the per-token rate, which is set above the outbound call rate, the route answers 429 or 503 so the provider retries; nothing is acknowledged before its durable insert. Receipts are kept 7 days.
   - **Trust.** Everything inbound is untrusted data. Only closed codes leave the minimiser, they move only along code paths, and none reaches a model.
8. **Limits, health, reconnect, disconnect and deletion.**
   - **Rate limits.** Each entry declares its provider's limits. A per-connection token bucket in SQL paces calls (one a second until the entry says otherwise) and honours `Retry-After`.
   - **Health.** ADR-0038's cron object schedules an ids-only, read-only check of each connection every 15 minutes: `active`; `degraded` after 3 failures in a row; `reconnect_needed` on any refused credential or an hour of failures; `disconnected`. `reconnect_needed` sets a system stop on the connection, which stops every plan that uses it (as ADR-0025 item 10 does for scopes), and puts one Inbox item before the Owner and the person who connected it. Resuming is a reviewed action (ADR-0005 item 1).
   - **Disconnect** is `governance.connection.disconnect`, the existing kill switch with no second approver, in two phases.
     1. One audited transaction marks the credential `revoking`, sets the stop on dependent plans, ends attempts not yet dispatched (`skipped_connection`) and retires every token except those of attempts in flight (`dialing`, `submitted`, `in_call` or `uncertain`). Those calls' tokens and the connection's event route stay alive: the call-instruction route serves only the plan's approved stopped closing (item 14), and signed events still settle their attempts. While `revoking`, the credential is usable only by the hang-up and revoke adapters and to verify those events. The broker reads the credential's state as it opens it for a call request; a `revoking` credential sends nothing, which proves the attempt was not sent, and the attempt ends `skipped_connection`.
     2. Ledgered operations hang up queued or ringing calls and revoke what the provider allows. When these settle and every in-flight attempt is settled, or at a 10-minute deadline, the remaining tokens are retired and the vault rows destroyed; anything unsettled then stays `uncertain`, with an Inbox item.

     Contact logs stay on their clocks. The screen says what stays at the provider (its own call records) and how to delete it there.
   - **Deletion.** Uninstall, `shop/redact` and workspace erasure destroy the affected connections the same way, in-flight calls' tokens included, through ADR-0031's one registry. The uninstall screen says that the stop list goes too, so past opt-outs are lost on reinstall.
   - **Sweeps per tenant.** The health, missed-order, settlement and holdout sweeps list tenants through a definer and run each tenant's work under that tenant's own context; no sweep queries across tenants under one context (`lab:tenant-conformance`). Each sweep's cursor and schedule state live in Neon, per tenant and store; ADR-0038's cron object only calls `redrive()` and stores nothing.

### B. Customer contact

9. **A capability class of its own** (amends ADR-0023 decision 8).
   - **Capabilities**, in a new domain "Customer contact":
     - `contact.rule.propose` (internal_write): drafts a call plan. It grants nothing.
     - `contact.rule.activate` (control, `human_only`, review-required): approves a plan or a revision (item 10).
     - `contact.rule.pause` (control, `human_only`, not review-required): held by the Owner, Admins and the plan's installation owner. Agents only propose it. Resuming is a reviewed action through `contact.rule.activate`.
     - `contact.rule.revoke` (control, `human_only`, not review-required): held by the Owner and the plan's installation owner. Agents only propose it.
     - `contact.stop` (control, `human_only`, not review-required): "Stop customer contact" for the workspace (item 14), held by every Owner and Admin.
     - `contact.attempt.send` (communication, `agent_after_approval`, irreversible, so it joins ADR-0011 Q4's list): one contact under an active plan, dispatched only by code (item 12).
     - `contact.results.read` (read): per-order outcomes for people; counts for agent runs (items 16 and 21). It is a customer-class read tag (amends ADR-0031 item 6).
     - `contact.test_recipients.revise` (control, `human_only`, Owner only): the sealed test numbers, each active only after the Owner proves they hold it (item 26).
     - `contact.test_call.place` (communication, `human_only`, Owner only): one test call to an active test number with a plan draft's rendered script. Its only recipient is a number the Owner has proven is theirs, so it is in the internal risk class by an ADR-0011 Q9 override, and the Owner's tap is its approval; at most 10 a day, verification calls included.

     The three stop controls never reserve credits and are never blocked by credits (ADR-0011 Q8).
   - **Who holds them.** The store-link template v2 (ADR-0025 item 7) issues the Owner the `contact.*` capabilities with `read_orders`, and `orders.tags.add` and `orders.cancel` with `write_orders`, each with its template verbs and revoked with its scope (`lab:group:pg-linking`). Admins hold `contact.rule.pause` and `contact.stop` by role; a plan's installation owner holds pause and revoke on that plan, as with `workspace.routine.revoke` (ADR-0024 item 4). The Phone field is not a scope: admission and dispatch check it (item 12).
   - **The Owner, as requester or approver.** A connection of a communication kind, a plan, a package that holds `contact.attempt.send`, and any change that widens one of these needs the Owner as its requester or its approver, as items 4 and 10 and ADR-0037 item 5 say.
   - **Purposes** are a closed list. At first there is only `cod_confirmation`. Marketing, upsells, prepaid-conversion offers (even with no incentive), surveys and review requests are never purposes: a promotional element makes the call promotional under TRAI's rules and the template marketing under Meta's, and an upsell is telemarketing under the US rule.
   - **Channels:** `voice_call` (scripted, item 11), and `whatsapp_template` once its entry is approved (item 17).
10. **Call plans: one exact approval, then each contact within it.** This amends ADR-0011 Q3 and Q9 for this capability only (owner question 6).
    - **`ContactRule@1`** is closed and digested with RFC 8785. Its digest binds:
      - the store, the installation, the purpose and the region policy version;
      - the order filter (item 18) and the policy mode (item 13);
      - the channel sequence, a closed preset, with each attempt's offset from the order;
      - per channel: the connection; the caller number, picked from that account's own numbers, which the broker lists and nobody types;
      - the template ids with their content digests, the renderer version, the provider markup-builder version, and per template the speech voice id, language code and number-and-currency locale;
      - the default language and the optional second language (item 11);
      - the Owner-set spoken shop name;
      - every segment the customer can hear, closings included (the stopped closing of item 14 among them);
      - the hours, the sequence window, the per-number caps and the daily limit in COD orders;
      - the outcome map: item 19's tags, and item 20's cancellation proposals;
      - the holdout share (item 25) and the expiry.

      The model writes none of the content. It picks presets and list values, and code fills the rest. A Morrow release that changes a pinned renderer, builder, voice or segment renders active plans with their pinned versions; if it cannot, the attempt is refused (`rule_render_mismatch`) and the plan needs a new revision.
    - **Person-only fields.** Only a person sets these, on the review card: the spoken shop name, the caller number, the daily limit above its default, and the holdout share once item 25 lets it change. Until about 300 held-out orders have settled, the share is fixed at 10%, at setup too. `contact.rule.draft` cannot set them (`tool-catalogue.test.mjs`).
    - **Review.** Activation is an access change with the communication class's rule merged in (both share the solo-owner typed confirmation, quorum 1, 24 hours pending and 1 hour approved). The Owner is the requester or the approver.
      - The card shows the plan in plain words; the full rendered script, in every language, for a recent real order (order number and amount, never a phone); "Call me now"; the hours in the customers' time zone, with what happens to orders outside them; the outcome map; an estimate of calls a day; the provider's cost from its published rate, marked as an estimate until real costs arrive; and the notice kit's status.
      - The phrase is exact: `approve calls for up to D COD orders a day`.
      - **At setup** (owner question 12) one review document holds two digests, the teammate's install with its mandate and its first plan, under one phrase, `add COD Confirmation and approve calls for up to D COD orders a day`, and one cool-down. Each digest stays its own: an edit to either is a new document. ADR-0024 item 2's install document thus also carries the plan's digest (an amendment).
      - A solo Owner waits out the 300-second cool-down and may cancel. In a team, ADR-0024 item 2 and its owner question 1 (b) apply.
    - **Life.**
      - A plan ends with its installation's mandate (90 days), so one renewal card covers both, with notices at 14 and 3 days and a banner 14 days ahead. Renewal is a new approval of a new digest.
      - Any edit is a new revision that needs a new approval. Until it passes, the old revision keeps running under its own approval, or pauses if the editor chose that. This is the change to CLAUDE.md's "Any edit invalidates them" that owner question 6 shows: the edit never touches the approved revision's digest, and it voids no approval of the old revision until the new one is active. An attempt is admitted only under the active revision, and its row records the digest it rendered; a superseded revision admits nothing. A running sequence keeps its counts, and the stricter of the old and new caps applies to it.
      - Pause and revoke stop new attempts at once; an attempt already submitted finishes and is reconciled.
      - A plan also ends with its connection, a lost grant or scope, or the end of the Owner's membership.
    - **One plan per order and purpose.** A sequence is unique per (store, order, purpose), and a plan whose filter overlaps an active plan of the same purpose on the same store cannot activate.
    - **What one approval covers.** Each contact that a verified order event admits under the plan, with the approved content, to the recipient kind it names (item 11), within every bound, until the plan ends; and the tag writes its outcome map names. It covers nothing else: no other purpose, template, channel, number, hours, store or recipient kind.
11. **Exact content, fixed by code** (owner question 5).
    - **Scripted calls only.** A call speaks only approved text through the provider's synthetic voice and takes answers by keypress. Spoken answers, recording and item names are not in v1 (item 15).
      - Free-form AI conversation is not offered. It would put model speech that nobody approved into a customer's ear, open an audio injection channel and bring in another model provider, and in India it raises the media-anchoring question. It would need its own record that changes the exact-content rule.
    - **First-party templates.** `ContactTemplate@1`, one per purpose, channel and language, is written and reviewed by Morrow's team, versioned in the repository and pinned by digest. It is made of segments with closed variables. A merchant picks among templates and sets only the person-only fields of item 10; free-text wording is not offered. A native speaker reviews each translation before release. en-IN and hi-IN come first; other Indian languages are data-only additions. CS10 confirms that the provider's speech covers each language well; where it does not, the template uses recorded segments for the fixed text.
    - **The opening is fixed and starts within 2 seconds of answer.** Its first sentence names the shop, says the call is automated and names the order: "Hello, this is an automated call from {shop} about your order {order} for {amount}." Code refuses a template without it. That meets the AI Act's Article 50 disclosure if counsel confirms it. The US identification rule also needs the registered name and a callback number, which the US policy would add when that country opens.
    - **Variables** are closed and filled by code from the system of record at dispatch: the spoken shop name (fixed at approval, letters, digits, spaces and `&'.-` only, at most 40 characters, attested to match the caller ID's registered name); the order name, which must match `^#?[A-Za-z0-9-]{1,20}$` or the attempt is refused (`order_name_invalid`); and the order total, formatted by code in its currency. Never an item title, a customer's name or address, or model output.
    - **Markup is built, never concatenated.** A typed builder escapes every text node, so no variable can inject `<Play>`, `<Dial>` or `<audio>`. Each case is a `lab:contact-dispatch` row.
    - **Keys:**
      - 1 confirms;
      - 2 cancels, confirmed by pressing 2 again;
      - 3 asks the shop to call back (a task for a person; no live transfer);
      - 8 says "not my order" (`wrong_number`);
      - 9 stops calls from this shop;
      - 0 repeats the message in the plan's second language, when it has one.

      No input or an invalid key repeats the question once, then ends with a fixed closing. Each closing promises only what is true: "We've passed your request to cancel to {shop}."
    - **The recipient kind** (amends ADR-0030 item 9; one of the two kinds this record adds, for `contact.attempt.send` only; the other is item 26's test numbers) is the phone number on the order that started the sequence.
      - The broker reads it from Shopify at dispatch, in a fixed order: the shipping address's phone, then the order's phone, then the customer's phone. Whether the shipping phone may be used when it could belong to a gift recipient is a counsel question (item 13).
      - It is normalised to E.164 and refused unless its type is exactly mobile, in a country the plan and the region policy allow; premium-rate, shared-cost, VoIP and fixed-or-mobile numbers are refused (`not_mobile`). No phone at all is `no_phone`.
      - No tool, model, person's text or event payload ever supplies a recipient.
12. **Each contact runs in code only, through the gateway.**
    - **Sequences.** A verified order event that matches an active plan (item 18) is first sorted by the plan's keyed holdout hash (item 25). A held-out order gets one `contact_holdouts` row and no sequence. Any other gets one `contact_sequences` row and one `ContactSequenceWorkflow` instance in the orchestrator, with ids only. The workflow sleeps to each attempt's time and then calls `admit_contact_attempt`. That definer takes ids only, is executable only by `morrow_runtime_executor`, is idempotent on a unique (sequence, attempt number), and is the only way a contact attempt is created.
    - **`admit_contact_attempt` checks, in one transaction:**
      - the plan is active, and its revision and digest are current;
      - the installation is unpaused and its mandate is active;
      - the Owner's current authority;
      - no workspace, installation, connection, capability, contact or platform stop (item 14), and the connection is `active`;
      - the store's scopes include `read_orders` and the Phone field is granted, and the switches are on;
      - every earlier attempt in the sequence is settled and none is `uncertain`; SQL computes the earliest time from the order and the plan's offsets, so no caller can bring an attempt forward;
      - the region policy: the country is open, the local hours allow it, and the attempt fits the policy mode's window (item 13);
      - suppression, the per-number caps and the plan's daily limit;
      - the order is not already confirmed or ended.

      It then creates the attempt and its operation. The operation is `Operation@2`'s plan-bound kind (ADR-0022 item 2, as amended): no task or proposal of its own; it binds the plan revision, the revision's activation approval and the sequence, and the gateway claims it like any other.
    - **Refusal codes, the complete closed list.** An attempt that ends without a call carries exactly one:
      - at admission, and again at dispatch when a re-check fails: `rule_inactive` (the plan, its revision or its mandate is no longer active), `authority_lost` (the Owner's current authority or the installation's grants), `scope_missing` (`read_orders` or the Phone field), `switch_off`, `stopped`, `connection_unhealthy`, `earlier_attempt_unsettled`, `region_closed`, `outside_hours`, `outside_window`, `suppressed`, `number_cap`, `daily_limit`, `order_changed`, and, only if owner question 16 is answered (b), `insufficient_credits`;
      - at dispatch only: `no_phone`, `not_mobile`, `order_name_invalid`, `rule_render_mismatch` and `skipped_test_mode`;
      - at disconnect: `skipped_connection`.

      A held-out order has no attempt, so it has no code. Any other code is a contract change.
    - **Dispatch.** The broker runs steps 1 to 5 in one transaction holding the sequence's row lock, and commits it:
      1. re-runs every admission check, in the same SQL as `admit_contact_attempt`: the plan active with an equal digest; the installation and its mandate; the Owner's current authority; every stop; the connection `active`; the scopes and the Phone grant; the switches; the region policy;
      2. re-reads the order: open, unfulfilled, not cancelled, still COD by item 18's full test, and its `createdAt` inside the plan's window;
      3. reads the phone, computes its digest, and checks suppression and the caps again on that digest; while `contact-live-recipients` is off, any digest that is not an active test digest ends the attempt `skipped_test_mode` (item 26);
      4. renders the script from the approved digests and code values, and checks that the render matches the plan;
      5. marks the operation started and the attempt `dialing`.

      Only after that commit does it place the call, holding no transaction or lock across the provider request. A failed commit leaves no mark and places no call, so a retried dispatch starts again at step 1; once the mark is committed, any retry refuses a second send. The provider's reply and every event-driven outcome write are their own short transactions that take the same row lock and move the attempt only forward from its recorded state, so the answer fetch never waits on the call request.
    - **The call is a small state machine in code.** Plivo fetches call instructions from `/services/c/:callToken/:step`. The broker verifies the signature, nonce and per-call token; finds the attempt in `dialing`, `in_call`, `submitted` or `uncertain` (a signed answer fetch is the best proof that a call exists, so it binds the provider's call id to the attempt and moves it to `in_call`); refuses terminal states; checks the stops again; and returns markup built from the approved segments. Each keypress moves the attempt to the next closed state. The provider's own speech engine speaks the text, so call audio never passes through Morrow.
    - **Inbound calls never reach Morrow.** The answer and hangup addresses are passed on each call request. Morrow never sets a number's application or inbound routing, and qualification asserts it; customers who call the number back reach whatever the merchant has set up.
    - **Outcomes** are closed: `confirmed`, `cancel_requested`, `callback_requested`, `opted_out`, `wrong_number`, `no_input`, `no_answer`, `busy`, `failed`, `uncertain`. A machine that answers hears the opening and the question like a person; there is no answering-machine detection, because a false "machine" makes a silent call.
    - **No model in this path.** No agent run starts for an order, and no model sees an order's contact. This is the action-selector pattern: what the customer presses only selects among closed outcomes, which code maps to the plan's approved actions.
    - **Retries and ends.** An attempt that ends `no_answer`, `busy`, `no_input` or `failed` before connecting schedules the next one by the plan's offsets, inside the hours and the window. The sequence ends at a terminal outcome; when its window or its offsets run out (`unconfirmed`); when the order is cancelled, fulfilled or paid (`order_changed`); at an `uncertain` attempt; or when its plan or a stop ends it.
13. **Consent, hours, opt-out and the region policy** (India first; owner question 11).
    - **`RegionContactPolicy@1`** is versioned data in `docs/decisions/contact-policy.json`, with its sources. Per country, purpose and channel it holds: open or closed; allowed local hours; the transactional window; attempts per order; contacts per number per 24 hours and per 30 days; the disclosure and opt-out duties; a required caller-number series, if any; the registered-name and callback fields, if required; and whether counsel has confirmed it. A plan pins its version. An unknown or closed country is refused (`region_closed`). Only India is written now; other countries stay closed until their own policy and counsel.
    - **India** is open on the owner's store now, and for outside merchants only after counsel at G16. Hours are 09:00 to 21:00 IST at most, narrowed by the plan.
    - **Two policy modes.**
      - **Transactional window only** (the default until counsel answers). Every attempt starts strictly within 30 minutes of the order (a start at 30:00 or later is outside), where TCCCPR treats a confirmation as a transactional call that needs no explicit consent. The default sequence is a call about 1 minute after the order and a second at 12 minutes if the first was not answered. An order placed when no attempt can start inside the window and inside the hours (late in the evening from about 21:00, and at night until shortly before 09:00) is not called; it ends `unconfirmed` and appears on the next day's list. The setup guide and the review card say this plainly.
      - **Extended.** Also a third call 2 hours after the order, and calls for orders placed outside hours at the next opening, within 24 hours. These rest on reading them as service calls about delivery. If TRAI reads them as calls that facilitate the ongoing purchase, they need explicit consent recorded through DLT's consent registrar, and complaints can bar the merchant's lines. Extended mode needs counsel's answer for any merchant; on the owner's store the owner may choose it earlier, accepting that risk in writing (owner question 11 (b)).
    - **Attestations at connect,** recorded with the names of the numbers and confirmed again at each renewal: the numbers are declared with the operator for automated calls under the Third Amendment; any DLT or principal-entity registration the operator or provider requires is done; and the KYC name that CNAP displays matches the spoken shop name.
    - **Opt-out.** Key 9 writes a suppression row at once: the phone's keyed digest, for the workspace and store, across every channel, purpose and plan. It is checked before every attempt. A person can add a number to the list by order reference (the broker reads and digests the order's phone), never by typing a number. Nobody can remove a suppression; only the customer's own later opt-in could, and this record does not build that.
    - **Optional "don't call me" at checkout.** If the merchant adds a checkout choice, the Owner maps its field once, and code reads it as one closed value; an order that carries it is never called (`suppressed`).
    - **The system contact stop**, like ADR-0030 item 9's mail stop. Over a rolling 7 days it stops a plan when opt-outs reach 3% of answered calls (at least 5), or wrong numbers reach 5% (at least 5). It stops the connection, and so every plan that uses it, when: abandoned calls (answered, then ended by Morrow or the provider before the opening finished) reach 3%, or silent calls (answered with no markup served within 2 seconds) reach 1%, of at least 10 answered calls in 24 hours; at least 30% of attempts end `failed` in an hour (at least 10); or a spam flag, complaint or barring notice is reported by the provider or by the merchant, who has a "Report a spam flag" button. Only a person lifts it, after seeing the counts.
    - **Counsel's questions before any outside merchant (G16):** whether a later call is a service call; whether an e-commerce sender must register on DLT or as a principal entity for ordinary numbers, and whether Morrow is a telemarketer; the Third Amendment's Gazette date; WhatsApp's position under TCCCPR and the Telecommunications Act 2023; DPDP section 7(a) for the confirmation call and for a shipping phone given by someone else; Rule 8(3) against deletion at redact, and suppression kept after redact; transfers under section 16; section 9 for children; the IT Act and SPDI Rules until DPDP starts; CERT-In's reporting time and log location; and Shopify's terms on a kept suppression digest. US, EU and UK questions wait for those countries.
14. **Stops** (owner question 19).
    - `agents.installation.disable` ("Stop AI work") on an installation stops its plans, attempts and contact-driven tag writes, though no model runs in them.
    - **"Stop customer contact"** (`contact.stop`) is a new workspace kill switch: `human_only`, no second approver, usable by any Owner or Admin, proposed only by agents. It is a tenant-wide stop on `contact.attempt.send`, `contact.test_call.place` and contact-driven `orders.tags.add`.
    - The platform stop (ADR-0022 item 15) covers contact too, and so does the workspace stop of ADR-0040 item 10 once it lands. That stop ends runs and blocks admissions; this record extends it to the contact path, which runs no model (amends ADR-0040 item 10).
    - All of them are checked in `admit_contact_attempt`, at the broker's mark-started step and in the call-instruction route.
    - **In-flight calls.** On any contact stop, plan revoke or disconnect, the broker makes a ledgered, best-effort hang-up of queued and ringing calls. A call answered after the stop hears the plan's approved stopped closing ("Sorry, we can't take your answer now. Goodbye.") and is hung up; on disconnect, item 8 keeps the in-flight calls' tokens alive for this. Outcomes already given are still recorded, but while stopped no tag write is dispatched; cancellation proposals are only drafted for a person.
    - **No burst on resume.** Attempts whose time comes during a stop end `stopped` and are never retried. Lifting a stop resumes no plan by itself, ADR-0040's workspace stop included: each plan it stopped needs its own reviewed resume through `contact.rule.activate`, which covers only orders received after the resume unless the Owner opts older ones in.
15. **Customer data: the phone is used, never kept or shown** (amends ADR-0025 item 8; owner question 8).
    - **One more Level 2 field.** Morrow requests **Phone**, and no name, email or address for this purpose. On the public app it goes into the protected-data request with its purpose, order confirmation calls. On the owner's custom app it is requested in the developer dashboard. If Shopify requires the Address field to read a shipping address's phone (unconfirmed; CS8 checks it on a development store), the broker's fixed document still selects only the phone subfield, and the owner is asked again.
    - **Only the broker reads it**, from Shopify, at dispatch, under the attempt's operation, and sends it only to the connected provider. It is never stored in plaintext, and never in an event, a log, a Workflow, a Queue, a run, a model context, the sandbox, a notification or a screen. Provider callbacks carry it through the connector unread (item 7). Morrow keeps only a keyed digest (HMAC-SHA-256, with the workspace's key in the broker vault), used only for caps, suppression and redaction, never for profiling across orders. People who need the number open the order in Shopify.
    - **It is still personal data.** The digest, the contact log and an order's outcomes are pseudonymous personal data in law, so notices, the merchant agreement and `data-regions.json` describe them as such; Morrow's internal classes tag them `content: customer`.
    - **No recordings, no transcripts, no spoken answers in v1.** Each needs its own record: recording needs an announcement with its purpose, deletion at the provider and care in later regions; spoken answers need the entry record to confirm where speech recognition runs and that the provider keeps no transcript.
    - **The gate.** No real phone is read until both hold: the contact classes' deletion path is merged and passes (G9, P09.T05; item 24), and Shopify has granted the Phone field. Until then the only calls are verification and test calls to the Owner's own test numbers (item 26).
16. **The contact log, and what people see.**
    - `customer_contacts` holds one content-free row per attempt: plan and revision digest, order id and name, channel, connection and operation; the phone digest and country; scheduled and attempted times, and whether the attempt fell in the transactional window; status, outcome code and duration; the provider's reported cost and call id; the template digest. It is FORCE RLS and registered `content: customer` (item 24).
    - **People with `contact.results.read`** (the Owner by default, ADR-0031 owner question 4) see a log per plan by order number, each day's counts, the holdout comparison (item 25) and a timeline per order. No screen shows a phone number, a digest or a recording link. "Open in Shopify" opens the order.
    - **Plain labels.** Each code has one label and badge (ADR-0032 items 2 and 4):

      | Badge | Labels |
      | --- | --- |
      | Green | Confirmed |
      | Yellow, "your turn" | Wants to cancel; Asked for a call back; Check this call: we couldn't confirm whether it went out (an uncertain attempt) |
      | Blue, "being worked on" | Calling; Trying again at 2:14 pm |
      | Orange | Unconfirmed; Not called: outside calling hours, daily limit reached, calling service needs reconnecting, number called 3 times in 24 hours, no phone number, not a mobile number, stopped, and one plain label for each other refusal code of item 12; Wrong number; Asked not to be called |
      | Red | Call failed (only after the provider confirms it) |
    - **One "Calls are paused" banner** per page for any stop or reconnect, with how many orders are waiting and one button that names the fix ("Reconnect Plivo", "Review stop").
    - **Rights requests outside Shopify.** The Owner can export or erase one order's contact history; erasing keeps only its suppression row, if any.
    - The activity log records each plan decision, stop, connection change and settlement as content-free events.
17. **WhatsApp, when its entry is approved** (owner question 4). WhatsApp is the second channel, built only after the owner says which WhatsApp provider or BSP the shop uses, through Meta's Embedded Signup or that provider's own connection flow, never by asking a merchant to paste a system-user token and app secret. Its entry record must also meet these conditions:
    - **Opt-in.** A template is sent only to orders that carry a recorded WhatsApp opt-in, a closed field the Owner maps once (for example a checkout checkbox), and the Owner attests that it exists. Without it the WhatsApp step is skipped. An opt-out on any channel stops all channels.
    - **The exact template at dispatch.** The broker reads the template's status, category, body digest and button digests at each dispatch, or from a cache no older than 60 seconds, and refuses on any mismatch with the plan. Meta's status and category updates stop the plan at once. The remaining check-to-send gap is an accepted residual. A template that Meta files as marketing cannot activate a plan.
    - **Inbound.** The broker drops, with no storage, log or task, every inbound message that is neither a button token of an open attempt nor from a sender whose digest matches an attempt sent on that connection in the last 24 hours. It never fetches media, and drops `profile.name`, button text and free text; a fixed stop list per language counts as an opt-out, and any other reply from a contacted customer becomes a follow-up task ("Customer replied on WhatsApp about order 1042") for a person to read in WhatsApp, in item 24's `contact_follow_ups` class. A dedicated number for Morrow is recommended.
    - **Tenancy and verification.** `X-Hub-Signature-256` over the raw body; the WABA id and phone number id must equal the connection's; Meta's GET handshake with a per-connection random token held as `service_webhook_secret`, compared in constant time.
    - **Outcomes.** If the Cloud API has no read of a message's status (to confirm), `uncertain` is terminal for WhatsApp.
    - **Order.** The likely preset is WhatsApp at once and a call at 12 minutes if nobody taps, inside the transactional window; the per-number caps already count both channels.

### C. Order events

18. **Order events and the COD test** (amends ADR-0025 item 6).
    - **Topics.** Only `orders/create` and `orders/updated`, which ADR-0025 item 6 already subscribes under `read_orders`.
    - **The minimiser keeps closed values only**, never the raw strings: `payment_gateway_names` mapped to a payment class (`cod`, `other_manual`, `prepaid`) and a gateway-list id; `financial_status`, `fulfillment_status` and `cancelled_at`; `source_name` mapped to a closed enum (`web`, `pos`, `draft`, `app`, `other`); `customer_locale` checked against a closed list of language tags; and, instead of tags, booleans for the closed set of tags that filters use (Morrow's own, and any the Owner picks). It still never keeps a customer, address, email, phone or note.
    - **Is it COD?** Shopify has no COD flag, display names can be renamed, and other manual methods also report `manualPaymentGateway` as true. Code decides in two steps: on the event, a provisional test (a gateway on the store's COD list, and `financial_status` pending); at dispatch, the full test (the broker reads the order's transactions and checks for a gateway on the list with `manualPaymentGateway` true).
    - **The store's COD list** starts with Shopify's own COD gateway. The Owner may add gateway names that Morrow has seen on the store's orders in the last 60 days, for third-party COD apps. The broker builds the observed list from a live read when the Owner opens the setting, drops any value with 7 or more digits, and stores only what the Owner picks. CS8 confirms how each kind of order shows up on a development store.
    - **`OrderEventFilter@1`** holds the plan's closed predicates, evaluated in code: payment class; financial and fulfilment status; a total range and the currency; a chosen tag present or absent; the source (web by default); the order's age. It has no free-text expressions. Payload text never selects a tenant, a plan or an action.
    - **Missed events.** Every 5 minutes the cron object's re-drive reads, per tenant and store, the orders created since that store's sweep cursor, and admits any that matches a plan and has neither a sequence nor a holdout row yet. The cursor is a row in Neon, advanced in the transaction that records the sweep; ADR-0038's object stores nothing.
    - **Not a trigger kind for agent runs yet** (owner question 17). A general `order_event` trigger for mandate runs, which other agents could use, is deferred to its own change. The agent's own runs use ADR-0024's existing `schedule` trigger.

### D. Order changes from outcomes

19. **Tags under the plan** (owner question 9).
    - **A new capability**, `orders.tags.add` (external_write, review-required, reversible, `agent_after_approval`), appends one tag from a closed list to one order with `tagsAdd`. It never replaces the order's tags.
    - **Three tags.** An order with a sequence ends with at most one: `morrow-cod-confirmed`, `morrow-cod-cancel-requested`, or `morrow-cod-unconfirmed` (no answer, not called, opted out, wrong number, asked for a call back, or an `uncertain` attempt). It gets none when its sequence ends `order_changed` (the order was cancelled, fulfilled or paid), `skipped_test_mode`, during a stop, or with its plan's end; its outcome is still in Morrow's timeline and on the day's list. The detail lives in Morrow's timeline. Held-out orders have no sequence and get no tag, so staff treat them as before and the measurement holds. The setup guide gives the warehouse one sentence: "Ship confirmed orders. Hold cancel-requested. Decide unconfirmed by hand." It also says that automations built on these tags, such as auto-cancel, are the merchant's own decisions and should not penalise customers who opted out.
    - **What the plan approves.** The outcome map is in the plan's digest. A tag write is admitted by a definer that takes a sequence id, and the attempt id when an outcome drives it; checks the map in the revision's digest; and allows one write per (sequence, tag). Each write is a plan-bound gateway operation (item 12), whose input is the tag from the revision's map and the sequence's order, not a proposal's stored parameters (amends ADR-0022 item 7): claim, re-check, `tagsAdd`, read the order's tags back, audit. A failed or uncertain write is settled by the read, never repeated blind. Undo is a person's `tagsRemove` proposal.
    - **A fixed mutation list.** This path's Shopify client allows only `tagsAdd`, `tagsRemove` from a person's proposal, and `orderCancel` from an approved proposal, because `write_orders` covers far more.
    - **Scope.** `write_orders` joins ADR-0025 item 6's optional scopes. It is requested at setup step 2, before approval; it is revoked, as a ledgered operation, when setup is abandoned for 7 days or when no plan or package needs it. Whether `tagsAdd` on an order needs exactly `write_orders` is confirmed in CS11.
20. **Cancellation stays a person's decision** (owner question 10).
    - **A cancel request becomes one proposal.** Pressing 2 twice adds the tag, and code drafts one cancellation proposal (`orders.cancel`, irreversible): the order; reason customer; restock yes; no refund, since nothing was paid; staff note "Customer asked to cancel on a confirmation call" (at most 255 characters); and "Tell the customer", which sends Shopify's own cancellation email, off by default. Every field is in the digest.
    - **Approval.** The proposal goes to the Inbox, and to the embedded home's pending approvals, under ADR-0011's irreversible rule. A solo Owner may approve 2 to 50 in one typed confirmation (ADR-0024 item 9).
    - **Applying.** The gateway calls `orderCancel`, follows its job to the end and reads the order back. It refuses if the order has since been fulfilled, paid or cancelled.
    - **Never automatic.** No outcome cancels an order by itself, and no answer, a busy line or a wrong number never leads to a cancellation proposal. An automatic rule would need its own record after measured results, and for EU customers would also have to settle GDPR Article 22.

### E. Agents

21. **Who holds it, and the setup** (owner questions 7 and 12).
    - **First-party package: COD Confirmation** (`morrow.cod-confirmation`), built by Morrow's team with recorded evals. Grants: `contact.rule.propose`, `contact.attempt.send`, `contact.results.read`, `orders.read`, `orders.tags.add`, and `orders.cancel` with the `propose` verb only. Scopes: `read_orders`, `write_orders` and the Phone field. Trigger kind: `schedule`. No computer tools; ADR-0023 decision 6's rule extends to contact capabilities.
    - **Agent cards** (owner question 7). Recommended (a): in v1 only the first-party package holds contact capabilities. With one purpose and first-party templates, a card drafted "from the same presets" would be the package. The merchant still asks in their own words, and Morrow adds the teammate and fills its first plan from what they said. Cards may hold contact capabilities (option (b), amending ADR-0037 item 5) when a second purpose or merchant wording arrives; Level 2 reads and `support.*` stay off cards either way.
    - **The setup guide** on the teammate's page, Sunrise's guide with its progress figure in text ("1 of 3 done"): 1, connect your calling service (item 4); 2, allow tagging (`write_orders`; on the owner's custom app a dashboard to-do); 3, hear it and approve ("Call me now", then item 10's one review document). Morrow drafts the setup document; code fills the connection, numbers, store, policy version and templates.
    - **The model's tools** (amends ADR-0027 item 3):
      - `contact.rule.draft` writes a draft `ContactRule@1` from closed presets and lists, never a person-only field (item 10).
      - `contact.results.read` returns counts only: by day and outcome, the confirmed rate, and item 25's comparison.

      No tool places a contact, names a recipient, a number, a template text, a connection or a provider, or returns an order's outcome.
    - **Lists are posted by code.** The daily exceptions list (wants to cancel, asked for a call back, unconfirmed, wrong numbers, uncertain attempts) is built and posted by code in the teammate's Everyday work area, tagged `contact.results.read`, in its own class `contact_exception_lists` (item 24). Callback requests become follow-up tasks for a person, in the class `contact_follow_ups`. Neither is an ordinary post or task: both expire on the contact log's clock and go at `customers/redact` by the listed orders. Their lines carry order numbers and closed outcome codes only, never a phone or a name, so ADR-0041 item 31's customer identifier screen passes them, and their own class, not a message, holds them. The model never receives per-order outcomes.
    - **The agent's runs** draft and revise plans, explain the weekly numbers and suggest revisions. A run that read untrusted text, such as a product title or another member's post, is tainted as usual, and its plan drafts still need the Owner's exact approval.
    - **Everyday work** (ADR-0033 item 6). `EverydayAreaTemplate@1` "Cash on delivery": the goal "Confirm COD orders before they ship", measured in code, with a default threshold of 85% the Owner can change; the repeating task "Check unconfirmed COD orders", off until a person turns it on. Home's "Today" shows the counts ("41 confirmed, 3 want to cancel, 5 unconfirmed").
22. **The worked example, end to end.**
    1. **Setup.** The Owner asks Morrow. Morrow shows COD Confirmation with its setup guide. In Settings › Connected services › Plivo the Owner reads what will be sent and the India steps, sets the provider-side limits, enters the sub-account's Auth ID and token through sealed entry, and records the attestations. The broker checks the account and lists its numbers. Shopify asks for `write_orders`. The Owner seals their own number as a test number and types back the code its verification call speaks, then taps "Call me now" and hears the Hindi and English script for a recent order. The Owner picks the caller number and the spoken shop name, reads the plan (calls at about 1 and 12 minutes, 09:00 to 21:00, transactional window only, three tags, a 10% holdout, 200 COD orders a day) and types the setup phrase; after the cool-down the install, its mandate and the plan are active.
    2. **Order.** At 14:02 IST, `orders/create` arrives. It is verified, deduplicated and minimised: payment class `cod`, status pending. The plan matches, and the keyed holdout hash, checked before any sequence exists, says this order is contacted. One sequence and its workflow start.
    3. **Attempt 1, at 14:03.** `admit_contact_attempt` passes every check. The broker, under the sequence lock, re-runs every admission check, re-reads the order and its transactions, reads the shipping phone, computes its digest, re-checks suppression and caps, renders the script, marks the operation started and commits. Then, holding no lock, it calls Plivo with the per-call token in the answer and hangup addresses. Plivo's response marks the attempt `submitted`.
    4. **The call.** Plivo fetches the answer address with a signed V3 request. The broker returns markup that speaks the approved Hindi text within 2 seconds. The customer presses 1: `confirmed`. The signed hangup callback records the duration.
    5. **Tag.** The outcome map admits `orders.tags.add` with `morrow-cod-confirmed`. The gateway calls `tagsAdd` and reads the tags back; the operation is `verified`.
    6. **Cancel, if pressed.** "2, 2" gives `morrow-cod-cancel-requested` and one cancellation proposal in the Inbox. The Owner approves a batch, and the gateway runs `orderCancel` to the end and reads each order back.
    7. **No answer.** Attempt 2 runs at 14:14. If it is not answered either, the sequence ends `unconfirmed`, the order gets `morrow-cod-unconfirmed`, and it appears on the day's list.
    8. **Failure.** Suppose Plivo's response is lost after the mark. The attempt is `uncertain`. If Plivo's signed answer fetch arrives, it binds the call and the call goes on normally. If nothing arrives, the sequence makes no further contact, the order ends `unconfirmed`, and the Owner gets an Inbox item.
    9. **Weekly report.** A scheduled mandate run reads `contact.results.read` (counts) and posts the report. Code computes the holdout comparison; the agent explains it and may suggest a revision, which the Owner approves or not.

### F. Money, data, evals and delivery

23. **Credits** (owner question 16).
    - The merchant pays the provider directly, from their own account. Morrow's credits cover Morrow's own work.
    - Recommended (a): contact attempts are metered (count, channel, provider-reported cost) but not charged until rate card v1. The contact path runs no model, so Morrow's own cost per attempt is small, and an empty balance never silently drops a time-critical confirmation. The agent's model runs hold and draw credits like any run.
    - Option (b), amending ADR-0039 items 2(a) and 3: each attempt is a paid step priced on the rate card per channel, drawn when the provider accepts it. An attempt the balance cannot cover is refused at admission (`insufficient_credits`) with a "Calls are paused" banner.
    - The review card and the weekly report show both bills: an estimate at the provider from its published rate (Plivo India's page shows ₹0.38 a minute with a 30-second pulse, but other Plivo pages differ), replaced by the provider's reported costs once calls run, and Morrow's share. They also say "a try costs at the provider even when nobody answers".
24. **Data classes and clocks** (amends ADR-0031 items 1 to 4 and 7; item 6's read tag is in item 9; owner question 13).

    | Class | Kept |
    | --- | --- |
    | `service_connections` (no secrets) | until disconnected; content-free history 365 days |
    | Vault rows | destroyed at disconnect (item 8), replacement, uninstall, `shop/redact` or erasure |
    | Credential entry documents (metadata only) and one-time keys | documents 24 hours after use or expiry; keys at use or expiry |
    | `service_event_receipts` (minimised) | 7 days |
    | `contact_rules` and revisions | 365 days after the plan ends |
    | `contact_sequences`, `customer_contacts`, `contact_holdouts` (`content: customer`) | 90 days from the order or the attempt (ADR-0031 item 2); deleted at `customers/redact`, `shop/redact` or erasure |
    | `contact_exception_lists`: the daily exceptions lists posted by code (`content: customer`, read tag `contact.results.read`) | 90 days from the list's date, and never longer than the contact rows it lists; at `customers/redact` a listed order's line is deleted; whole lists at `shop/redact` or erasure |
    | `contact_follow_ups`: callback tasks, WhatsApp-reply tasks and Inbox items that name one order's contact, with their threads (`content: customer`) | 90 days from the attempt that made it, whether open or done; deleted at `customers/redact` by the listed orders, `shop/redact` or erasure. A person cannot copy one into an ordinary task, since copying never extends a clock (ADR-0031 item 2) |
    | Daily contact counts per plan and group, contacted or held out (no order, phone or digest) | 365 days |
    | `contact_suppressions` (digest, scope, date, source) | until `shop/redact` or erasure; kept after `customers/redact`, with no order link (owner question 13; the one class beyond ADR-0031 item 2's 90-day rule) |
    | `contact_test_recipients` (sealed numbers and digests; a pending number's verification code only as a keyed hash) | until the Owner removes them, or erasure; a number not proven within 24 hours, and every code after 10 minutes |

    - These lists and follow-ups are the only places a contact outcome leaves `customer_contacts`; ADR-0031 item 1's rule that tasks and threads stay until a person deletes them does not apply to them.
    - `customers/redact` deletes by the listed orders first, then by the digest of the payload's phone, because dispatch prefers the shipping phone. A listed order's pending cancellation proposal has its parameters emptied, keeping the digest, and never applies (ADR-0031 item 2). `customers/data_request` exports the matching contact rows to the Owner, without digests.
    - The 90-day clock is a maximum. DPDP Rule 8(3)'s one-year minimum binds the fiduciary once in force (about May 2027); whether Morrow keeps a minimal log for the merchant then is a counsel question, decided before that date.
    - `data-regions.json` gains a section "Services you connect" (each entry's provider and regions, and what Morrow sends there) and records the changed data categories at Morrow's own processors: the phone in transit through Cloudflare, digests and logs in Neon, and contact counts at Anthropic. It is generated into the privacy policy; the merchant's own notice is the notice kit (item 1).
    - S8 fails any contact class without its handler and clock. Each class's handlers, its CHECK-capped clock and its S8 rows land in the PR that first writes it (ADR-0031 item 4; G9): the connection classes in CS4 and CS6, the contact classes in CS9 and the lists and follow-ups in CS13 (`docs/plan/connected-services-implementation.md`). Whichever of CS9 and build order PR 25 lands first adds the registry's `customers/redact` trigger.
25. **Evals, and measuring the effect** (owner question 15).
    - **Code labs, on fakes only:**
      - `lab:service-connections`: the signed entry document and its refusal when altered or signed by an unknown key id; the api handler sees only ciphertext; a reused, expired or foreign document and a consumed key are refused; one provider account in two workspaces is refused; replacement; two-phase disconnect, where a call answered during phase 2 hears the stopped closing and its signed hang-up still settles it, and every token is gone after the deadline; failed health checks lead to `reconnect_needed` with a stop; egress only to the entry's hosts.
      - `lab:service-events`: a forged signature is refused before any parse; a replayed nonce; another account's signed event; a hint with no matching attempt changes nothing; another workspace's token; 429 over the rate.
      - `lab:order-triggers`: the provisional and full COD tests; a renamed gateway and a third-party gateway on the list; no raw tags, source or gateway strings stored; the sweep catches a missed event exactly once.
      - `lab:contact-rules`: the review, with the Owner as requester or approver, in a solo workspace and in a team where another member holds the store grants; the setup document's two digests; an edited, expired, revoked or paused plan admits nothing; an edited plan's old revision runs until the new one is active, and pauses if the editor chose that; overlapping plans; person-only fields, and a holdout share that cannot change before about 300 settled held-out orders.
      - `lab:contact-dispatch`: every refusal code of item 12's list, and no other; every admission check re-run at mark-started, the Owner's lost authority, a lost scope or Phone grant and each stop among them; the mark committed before the provider request, with no lock held across it, and a failed commit placing no call; a signed answer fetch served while the call request is still open; an unsettled earlier attempt; a lost response stays uncertain and nothing more is sent; a signed answer fetch on an uncertain attempt; an order cancelled between attempts; variable escaping and charset refusals; the render matches the digest; `stopped` after a stop, and no plan resumed when a stop is lifted; a held-out order gets no sequence; a test number is dialled only once its code is typed back; an old order refused; no phone anywhere but as a digest, in no table, log or event.
      - Rows in `lab:approval-records`, `lab:shopify-privacy`, `lab:retention`, `lab:tenant-conformance` and `stops.test.mjs` (`contact.stop`, the platform stop, the connection stop).
    - **Agent evals** (ADR-0041's eval programme): drafting a plan from the owner's words picks the purpose, languages, presets and holdout and nothing promotional; injection in product titles or posts never moves a plan outside its presets or sets a person-only field; report numbers equal SQL.
    - **Provider qualification**, on the owner's own accounts and phones only (item 26): every key and outcome path; signature and nonce checks; a forced lost response; rate limits; the opening within 2 seconds; no inbound routing set; free-text features off; and each provider-side limit the entry record names that the provider lets the broker read (item 4).
    - **The effect is measured, not assumed.**
      - Each plan holds out a random 10% of eligible orders, picked by a keyed hash of the order id before any sequence is created (item 12), recorded in Morrow only as a `contact_holdouts` row and never tagged.
      - Two tiers of results, each naming its source and time. **Now:** reached, confirmed, cancel requests, cancelled before shipping. **Later:** returned to you (RTO) by order week, counting only settled weeks and showing "still in transit: N" until then.
      - **RTO source.** At setup the Owner picks the tag or status their courier app writes for a return, from a list the broker builds as for the COD list. Until one is picked, the report says "RTO data not connected yet", never 0%.
      - Code compares contacted and held-out orders with 95% intervals, and says "Too early to tell. About N more orders needed." until the held-out group has about 300 settled orders. Until then the share stays at 10%, at setup too, and nobody can change it; after that the Owner may set it, from 0 to 30%, by a new revision. Once the contact rows expire, the comparison uses the daily counts per group.
      - An optional "Estimated savings", from the Owner's cost of a returned parcel, appears only once the interval excludes zero, labelled "Estimate".
      - No vendor numbers in product copy: "Shops report fewer returns; Morrow measures yours."
26. **Going live on the owner's store, step by step** (ADR-0035 item 4).
    - **Who does what.** Claude builds and tests on fakes. The owner does the provider steps (account, KYC, India region, sub-account, operator declaration, attestations), enters credentials through sealed entry, and grants Shopify's Phone field and `write_orders`. None of this goes through chat.
    - **Test numbers, proven first.** With `contact.test_recipients.revise` the Owner seals their own numbers (sealed entry; the broker keeps the number for dialling and a digest for matching). A new number is `pending`. The broker places one verification call to it, a ledgered operation through the gateway with a fixed first-party template that names Morrow and the shop and speaks a random 6-digit code twice, and nothing else (the same idea as ADR-0030 item 7's code for a support address). The Owner types the code back within 10 minutes; three wrong entries end it. Only then is the number `active`. At most 3 verification calls per number in 24 hours, counted in the 10 test calls a day; a number not proven within 24 hours is deleted. No test call, and no test-mode dial, ever goes to a `pending` number.
    - **Test calls.** "Call me now" dials only active test numbers with a draft's rendered script; it reads no customer phone, so it needs the gateway and its stops (G10) but not G9.
    - **Then test orders.** After G9 and the Phone grant, plans run in test mode while `contact-live-recipients` is off: the broker reads an order's phone, and dials only when its digest is an active test digest; other orders end `skipped_test_mode`. Test numbers are never substituted for a customer's. The owner places COD test orders with their own phone.
    - **Real customers** need the owner's OK in chat once, before `contact-live-recipients` goes on, which is the first live day, on top of the plan's approval. That is the one ask owner question 6 keeps from ADR-0035 item 4's per-send rule. Each live action gets its line in the activity log.
27. **Switches and order** (owner question 20).
    - Every switch is committed off: `service-connections`; `service-entry:<entry>` for each entry; `contact-test-calls`; `order-events`; `contact-rules`; `order-tag-writes`; `contact-live-recipients`.
    - Each goes on by one reviewed commit, after its labs, its entry's qualification, G10, and G9 for every switch that reads a customer's phone (`contact-rules` and after).
    - The PR order is in `docs/plan/connected-services-implementation.md`. The contact path needs no model, so it does not wait for the agent loop; the agent's own runs do. It is in launch scope if ready by G17, otherwise the first fast follow, and it never holds launch.

## Values

All values are catalogue or policy data. A value changes only through a new version with its evidence. SQL CHECKs hold only safety ranges.

| Setting | Value |
| --- | --- |
| Plan life | the mandate's 90 days; one renewal card; notices at 14 and 3 days |
| Plan approval | access change merged with communication; the Owner; `approve calls for up to D COD orders a day`, or at setup `add COD Confirmation and approve calls for up to D COD orders a day`; 300 s cool-down when solo |
| Calls (transactional window only) | about 1 minute after the order, and 12 minutes after it if not answered; every start before 30:00 |
| Calls (extended, after counsel or the owner's choice) | also 2 hours after the order; orders outside hours at the next opening |
| Sequence window | 24 hours from the order |
| Hours (India) | 09:00 to 21:00 IST at most, narrowed by the plan |
| Per number | 3 contacts in any 24 hours and 6 in any 30 days, across all plans in the workspace |
| Daily limit per plan | COD orders started; Owner-set; default 200, at most 2,000 |
| Holdout | 10%, fixed (at setup too) and never tagged, until about 300 settled held-out orders; then the Owner may set 0 to 30% |
| Plan stop (7 days) | opt-outs at least 3% of answered calls (at least 5); wrong numbers at least 5% (at least 5) |
| Connection stop | abandoned at least 3% or silent at least 1% of answered calls in 24 hours (at least 10); failed at least 30% of attempts in 1 hour (at least 10); any reported spam flag, complaint or barring notice |
| Opening | starts within 2 seconds of answer |
| Recording, spoken answers, item names | not in v1 |
| Test numbers | the Owner's own, active only after a spoken 6-digit code is typed back within 10 minutes (3 tries); at most 3 verification calls per number in 24 hours |
| Test calls | active test numbers only; at most 10 a day, verification calls included |
| Provider call rate | the entry's value; default 1 a second per connection |
| Inbound events | 64 KiB; receipts 7 days; 429 or 503 above the rate |
| Health checks | every 15 minutes; `degraded` after 3 failures; `reconnect_needed` on a refusal or after 1 hour failing |
| Disconnect | in-flight calls' tokens kept until phase 2 settles; deadline 10 minutes |
| Missed-order sweep | every 5 minutes |
| Credential entry document | 5 minutes, single use, signed by the broker |
| Contact log | 90 days, with the holdout rows, exceptions lists and follow-ups; daily counts 365 days |
| Cancellation batches | 2 to 50, solo typed confirmation |
| Everyday goal | confirm COD orders before they ship; default threshold 85% |
| Price per attempt | metered, not charged, until rate card v1 (owner question 16) |

## Security invariants touched

One invariant's granularity would change if the owner approves question 6, with the compensating controls below. Four CLAUDE.md lines would change in wording, each shown word for word on owner question 6: the two security invariants on exact approval ("Approvals are bound to a digest of the exact proposal. Any edit invalidates them.") and on agents' store changes ("Agents change it only through an approved exact proposal."), and the two "Provider and live effects" lines on the per-send ask and the store-change flow. With them change ADR-0035 items 4 and 5 (question 6) and items 3 and 7 (question 8). The customer-data invariant does not change. None is otherwise weakened.

- **Approvals bound to the exact proposal: the granularity changes.** One approval of an exact plan covers many sends and their tag writes (owner question 6). What stays exact: the plan's digest binds the templates, renderer, voices, locales, caller number, every audible segment, the hours, attempts, caps, outcome map and options; any edit is a new revision that needs a new approval; each contact's rendering must equal the approved template filled with code values, checked at dispatch; the recipient is the approved kind, filled by code from the system of record; tags follow the plan's map, and cancellations a person's own approval (`lab:contact-rules`, `lab:approval-records`, `lab:contact-dispatch`).
- **"Any edit invalidates them": what changes.** An edit to a plan never changes the approved revision, but the approved revision keeps running under its own approval until the edited one is approved, unless the editor pauses it (item 10). Owner question 6 says so. Every other approval in Morrow is still voided by any edit.
- **The owner's per-send ask** (CLAUDE.md; ADR-0035 items 4 and 5). Under a plan, the owner's in-product approval of exact content and bounds stands for each send, and the owner's OK in chat is needed once, before the first live day. CS2 commits the CLAUDE.md wording exactly as owner question 6 shows it; until it lands, nothing reaches a real customer.
- **Customer data** (ADR-0035 items 3 and 7; owner question 8; CLAUDE.md's customer-data line does not change). The Phone field enters for COD Confirmation instead of only with Support, still only after its deletion path (G9) and Shopify's grant. It is read only by the broker at dispatch, transits the connector unread in callbacks, and is stored only as a keyed digest; no model, run, screen or log receives it (`lab:shopify-privacy`, `lab:retention`, `verify:boundaries`).
- **Tenant isolation.** Every new table is FORCE RLS with composite tenant keys. Event and call tokens are hashed and resolved only in SQL by a connector-only definer, and an event's provider account must match its connection's; one provider account serves one workspace (`lab:tenant-conformance`, `lab:service-events`).
- **The intersection, in code, at each attempt:** the installation's grants, the active plan, the mandate, connector scopes (the Phone field, `write_orders`) and an active connection, live policy, the switches and stops, and the Owner's current authority; every one checked in `admit_contact_attempt` and again, in the same SQL, at the broker's mark-started step (item 12; `lab:contact-dispatch`, `lab:agent-authority-workers`).
- **Permission and budget checks in code.** Admission, caps, the stops and the region policy run in SQL and code. No model is in the contact path (`lab:contact-dispatch`).
- **Unknown outcomes reconciled before any retry.** Each attempt and tag write has one key for life; an uncertain attempt sends nothing more and is never promoted (`lab:contact-dispatch`).
- **Credentials only in the broker.** Sealed entry with a document the broker signs with its own key, placed by the owner and rotated by key id (item 5); the api relays only ciphertext; vault kinds carry associated data; adapters live in the broker with hosts fixed in code (`verify:boundaries`, `broker-vault.test.mjs`, `lab:service-connections`).
- **Default deny.** Switches are committed off. Contacts are refused without a plan, for unknown or closed regions, for services not in the catalogue and for unqualified entries (`edge:check`).
- **Kill switches `human_only`.** Disconnect, plan revoke and pause, and "Stop customer contact" need no second approver, and agents only propose them; system stops are lifted only by a person (`stops.test.mjs`).
- **No agent-initiated external effect before P11.** Contacts and tag writes are gateway operations only, behind G10.
- **The owner's store only; fakes in CI.** Test calls to proven test numbers first, then test orders, then the owner's one OK in chat for real customers.
- **Immutable migrations.** Forward only (`migration-history.test.mjs`).
- **Accepted residuals.**
  - A compromised connector relays the call-instruction markup and every callback body, so it can rewrite what an answered call does. It can change the words spoken; insert `<Dial>` to connect the customer to any number, at the merchant's cost; insert `<Record>` to record the call; read customers' phone numbers in callback bodies, as it could read them in the Shopify order webhooks it passes unread (item 7); and drop or replay callbacks. Nonces and the broker's state machine limit replays, and deploy controls (ADR-0014, ADR-0019) are the defence, with the provider-side limits as a second line where the provider offers them: outbound calls to India only, and transfer and recording off (item 4), asserted by qualification. It cannot place a call, create or widen a plan, start a sequence for anything but a real, open COD order created inside the plan's window (the broker re-reads it), or pass a stop.
  - A compromised orchestrator can delay or skip attempts, but cannot bring one forward or add one.
  - A compromised web Worker, an XSS bug or a browser extension can read a secret while it is typed into the sealed form, as with any web form.
  - Fake orders placed with someone else's number. The per-number caps, key 8, key 9 and the wrong-number stop bound the harm. Test numbers cannot be used this way: each is proven by its spoken code (item 26).
  - For WhatsApp, when it comes, the gap between the template check and the send (item 17).

## Consequences

- **The answer to the owner is yes.** A person asks Morrow for it in their own words, and Morrow adds a COD confirmation teammate that calls customers through the merchant's own calling service. The calls use fixed, approved words and keypresses; outcomes become Shopify tags, cancellations are approved by a person, and the effect is measured against a holdout. It is not a free-form AI conversation, and no agent ever handles a phone number.
- **What becomes possible on the same foundation:** WhatsApp confirmation (owner question 4); delivery follow-up calls after a failed delivery, as a second purpose by its own record; courier entries for exact RTO data; the merchant's own mailboxes (ADR-0030 item 10); SMS under India's DLT rules; order events for other agents (owner question 17).
- **Code:** contracts and fakes; service connections (data, vault kinds, sealed entry, events, health, limits, two-phase disconnect); order events; call plans and the contact gateway; the Plivo adapter; order tags and cancellation proposals; the contact classes' deletion path; the agent, the screens and the evals. About 14 code PRs; the order is in the plan.
- **Owner work:** the provider account, KYC, the operator declaration and the provider-side limits; the entry-signing key; Shopify's Phone field and `write_orders`; proven test numbers and test orders; the one OK in chat before real customers; which WhatsApp provider the shop uses; counsel and the merchant agreements before outside merchants (G16).
- **Cost to the merchant**, approximate: telephony at the provider (Plivo India's page shows ₹0.38 a minute with a 30-second pulse, plus about ₹200 a month for a number, but other Plivo pages show different rates); WhatsApp utility messages, later, at about ₹0.12 to 0.15 each from third-party figures; no Morrow credits per attempt until rate card v1 if owner question 16 is answered (a).
- **Risks:**
  - India's rules are new and partly unconfirmed. Mitigation: transactional-window-only by default, the counsel gate, attestations, and the policy as versioned data.
  - Spam flags and line barring. Mitigation: caps, the plan and connection stops (including abandoned and silent calls and merchant reports), short purpose-bound calls, and the declaration.
  - Orders placed outside calling hours are not called in the default mode. Mitigation: they go on the morning list; WhatsApp, later, can reach them.
  - COD detection errors. Mitigation: the two-step test and an Owner-picked gateway list.
  - The effect may be smaller than vendors claim, and RTO may not be visible in Shopify. Mitigation: the holdout, settled weeks only, and the Owner-picked RTO source.
  - Setup takes provider KYC that competitors' bundled telephony avoids. Mitigation: the setup guide says so honestly; bringing their own provider was the owner's choice.

## Alternatives considered

- **A tap for each call.** It fits today's rules, but a COD confirmation has a 30-minute window and a shop gets hundreds of orders a day.
- **A free-form AI voice agent from a voice-AI provider** (Exotel Voicebot, Bolna, ElevenLabs, Retell). Unapproved model speech, an audio injection channel, another model provider and India's media anchoring, for little gain on a yes/no question.
- **A generic HTTP, webhook or bring-your-own-MCP tool.** The model or the merchant would name URLs and credentials: SSRF, no reconciliation and no review.
- **A calling account that Morrow manages and pays for.** Morrow would become the sender for every merchant, with their KYC, registration and telephony cost. The owner asked for merchant-provided services.
- **An agent run for each order.** Cost, latency and an injection path, for no gain over code.
- **Storing phone numbers, even encrypted.** Not needed: the broker reads the phone from Shopify at dispatch.
- **Automatic cancellation when nobody answers.** It harms customers who simply missed a call.
- **Twilio, Vapi or Retell numbers for India.** Twilio dials India only from international numbers, Vapi is unsupported for Indian numbers, and Retell's numbers dial only the US.
- **A prepaid discount on the call.** Promotional under TRAI, marketing under Meta, telemarketing under the US rule.
- **WhatsApp first, through the raw Cloud API with pasted tokens.** Developer work for a non-technical merchant, and it needs Meta's opt-in, which most COD checkouts do not collect yet.
- **Answering-machine detection.** A false "machine" makes a silent call, which TRAI counts against the sender.

## Reviews of the draft

Three separate-context reviews (security, legal and privacy, product) ran on 2026-10-26. Every sound high and medium finding is in the items above. Not taken, and why:

- **One digest for the agent and its first plan** (product): two digests in one document instead, because the install and the plan have different lives (revisions, renewals, stops).
- **Dropping test recipients for "Call me now" alone** (product): test numbers stay, because after G9 the real order flow must be tested end to end on the owner's own phone.
- **Deciding a legal-hold log under DPDP Rule 8(3) now** (legal): the duty is not in force and binds the fiduciary; counsel decides before about May 2027, and until then contact rows keep ADR-0031's 90-day clock.
- **Every eligible order ending with a tag** (product): held-out orders stay untagged, as the same review's holdout finding asks.
- **WhatsApp details in v1** (security, legal): their fixes are kept as conditions on WhatsApp's own entry record (item 17), since WhatsApp waits for the owner's answer on providers.

An AI review of pull request 86 (separate context, same model family) then found 19 defects, all fixed in this text: one list of the CLAUDE.md lines and ADR-0035 items that change, with the exact CLAUDE.md wording on owner question 6; every amended record named; each contact class's deletion path in the PR that first writes it; every admission check re-run at dispatch; the started mark committed before the call; in-flight calls kept through disconnect; classes and clocks for the posted lists and follow-up tasks; the Owner as requester or approver in item 9; the compromised-connector residuals and the provider-side limits; proof of possession for test numbers; and the low findings.

## Owner questions

Each one is on the decision sheet, Q-adr-0042-owner-questions, with its recommendation and the reason for it.

1. Services only from Morrow's catalogue, connected with the merchant's own accounts; no custom APIs or MCP servers. *Recommended: yes.* (items 2 and 3)
2. Keys entered through sealed entry signed by the broker, from a sub-account; never shown again; no account passwords. *Recommended: yes.* (items 4 and 5)
3. Each new service needs its own one-page entry record that you approve. *Recommended: yes.* (item 2)
4. The first service: Plivo calls (India region); WhatsApp second, through the provider you already use. Which calling service, and which WhatsApp provider, do you use? *Recommended: Plivo first; WhatsApp after your answer.* (items 2 and 17)
5. Scripted, keypress-only calls; no free-form AI, recording, spoken answers or item names in v1. *Recommended: yes.* (items 11 and 15)
6. Standing call plans: you approve the exact plan once and contacts run within it; an edited plan's old revision keeps running until you approve the new one. This changes four CLAUDE.md lines, shown word for word on the sheet and approved as shown by a "yes", and ADR-0035 items 4 and 5. *Recommended: yes.* (item 10; Security invariants)
7. Who holds it: (a) only Morrow's COD Confirmation teammate in v1; (b) agent cards too. *Recommended: (a).* (item 21)
8. Level 2 Phone only, never stored or shown; contact logs still treated as personal data. This changes ADR-0035 items 3 and 7 ("customer data comes last, with Support"). *Recommended: yes.* (item 15)
9. `write_orders`, requested during setup, with three append-only tags; held-out orders untagged. *Recommended: yes.* (item 19)
10. Cancellation always needs a person (batches of up to 50; the customer email off by default). *Recommended: yes.* (item 20)
11. India: (a) transactional window only until counsel; (b) also later calls on your store now, accepting the stated risk. Attestations at connect; other countries closed. *Recommended: (a).* (item 13)
12. One setup approval (the teammate and its first plan, one phrase, one cool-down) and "Call me now" to your own phone, proven by a spoken code. *Recommended: yes.* (items 10, 21 and 26)
13. Contact logs 90 days; daily counts 365 days; an opt-out kept as a fingerprint after a customer's deletion request, pending counsel. *Recommended: yes.* (item 24)
14. The safety values in Values. *Recommended: as written.* (items 10 and 13)
15. A 10% blind holdout, fixed until about 300 settled held-out orders, an RTO source you pick, and a weekly report. *Recommended: yes.* (item 25)
16. Credits: (a) attempts metered, not charged, until rate card v1; (b) priced per attempt now. *Recommended: (a).* (item 23)
17. A general order-event trigger for every agent: (a) later, by its own change; (b) now. *Recommended: (a).* (item 18)
18. Roles: the merchant is the sender and controller and Morrow its processor; a merchant agreement, contact terms and a notice kit before outside merchants. *Recommended: yes.* (item 1)
19. A workspace "Stop customer contact" switch for any Owner or Admin, with no second approver. *Recommended: yes.* (item 14)
20. Timing: build now as a parallel lane behind switches; test calls after G10; real customers after G9, Shopify's phone grant and your one OK in chat; in launch scope if ready by G17, otherwise the first fast follow. *Recommended: yes.* (item 27)

## Approval

Not approved. This record is Proposed.

The owner's question is quoted in full under Context and recorded as OD-2026-10-26-8. It approves none of this record's text.

Approval is the owner's own statement in chat, quoted here verbatim with its OD number: for example "approve ADR-0042 as recommended and the CLAUDE.md change", or answers by question number. A "yes" to question 6 approves the four CLAUDE.md lines exactly as the sheet shows them, as the owner approved ADR-0035's lines (OD-2026-10-23-10). Until then nothing that depends on this record merges. The records PR (CS1) may merge with the record still marked Proposed.
