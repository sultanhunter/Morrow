# ADR-0030 Email: inbound support mail by forwarding, approved replies through Resend, template-only notifications

- Status: Accepted 2026-10-23 (the owner, OD-2026-10-23-7: every owner question as recommended; owner question 1 changed (item 10))
- Date: 2026-10-23
- Supersedes: none.
- Amends: ADR-0022 item 7 (three Resend keys in the broker, development and staging only); ADR-0022 item 15 (a system mail stop, item 9); `support.reply.send` in `capabilities.json` (its digest fields, and dependency D10 becomes a new D22 `transactional_email`); the build plan's "vendor unselected" notes.
- Implements: ADR-0023 decision 8.
- Does not change: ADR-0005; ADR-0011 Q3 and Q4 (`support.reply.send` stays restricted and irreversible); ADR-0022 item 9.
- Relies on: ADR-0031 (`customer_mail`), ADR-0024 (approvers), ADR-0025 (Level 2), ADR-0027 item 5 (untrusted data).
- Terms: the Owner, as in ADR-0024.
- Unblocks: P17.T01, P17.T04, P17.T02 (through a new lettered child, P17.T02g), P07.T03, P07.T05, P05.T01z, P09.T05, P11.T02, P11.T03, P12.T04; track T11 and the email parts of T3, T5, T6, T7, T12, T14 and T15; gate G7.

## Context

The owner approved decision 8 with its recommended vendor: "yes to all recommended" (Q12). `main` has no mail code; `support.reply.send` is catalogued as restricted, review-required and irreversible; and the 0020 operations ledger never turns `uncertain` into success. Items 1, 2, 5 and 9 follow the public documentation of [Resend](https://resend.com/docs) (24-hour idempotency keys, a message read API, send-only keys) and [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), read 2026-10-23.

## Decision

1. **Inbound addresses.** Each workspace has one address, `inbox+<random token>@in.<domain>`, routed by one Email Routing rule per environment to an `email` handler in the connector Worker. A definer finds the workspace from the token in the envelope recipient only; headers never select a tenant. Unknown or rotated addresses are rejected; uninstalling Support closes the address. Gmail's forwarding code is shown only to the person setting it up.
2. **Inbound mail is untrusted data.** Email Routing's rejection is the launch sender check (owner question 4). A pinned parser keeps fixed headers and up to 64 KiB of plain text; raw MIME and attachments are never stored. Mail is `customer_mail` under the `support.case.read` tag. No run starts for auto-replies, bounces, list mail, Morrow's own copies, or mail past 300 a day per workspace.
3. **Drafting a reply.** Only Support's package may declare `support.*` capabilities; CI and install refuse any other manifest that does, and the Coordinator and specialists hold none. Support's tools take a thread id and a body; code sets every header. **To** is the inbound From address only; a message without exactly one starts no run. Order and customer reads match that address exactly, so order facts go only to the email on the order. Refunds and cancellations go to a person. Every reply carries `contextTaint: untrusted_external` and ADR-0011 Q3's communication rules.
4. **The send.** `support.reply.send` runs only at the gateway, after approval of its exact digest over From, To, Bcc, Reply-To, Subject, In-Reply-To, References and the plain-text body; any edit voids the approval. The broker's `mailSend(operationId)` takes only the id, needs a live lease and no stop, and treats a changed Bcc as a `conflict`. One OperationLedger operation has one key for life, `morrow-mail:<environment>:<operationId>`, and makes one `POST /emails`. Replies are plain text with no attachments or tracking; code refuses CR and LF in headers. The broker marks the send started under a row lock before calling Resend.
5. **Unknown outcomes: reconcile, never retry blind.** A 200 with an id is `submitted`; a documented pre-send refusal is `failed`; a 429 gets one same-key resend; anything else after the mark is `uncertain`.
   - **(a)** With a message id, Morrow reads its status; the read needs no lease and no stop check.
   - **(b)** Without one, at most two same-key replays, only while the lease is live, no stop applies and authority re-checks; then (a).
   - **(c)** Otherwise the operation stays `uncertain` and an Inbox item asks the approver and the Owner to check the Bcc copy. "Send again" is a new proposal, digest, approval and key, and its card warns that the first message may have arrived.
6. **Verification.** An operation is `verified` only when the status read matches the approved headers, `html` is empty, and the text's SHA-256 equals the approved body digest. Delivery status is polled for 72 hours and shown in Activity; a bounce raises an Inbox item.
7. **Bcc and identities.** Every reply has exactly one Bcc and Reply-To: the workspace's support address, verified by a 6-digit code, changed only by the Owner (`human_only`, audited). Replies come from `<shop handle>@replies.<domain>` with the shop's name (owner question 1); notifications from `notify.<domain>`. Nothing is sent from an unverified domain.
8. **Notifications are fixed templates.** Templates live in the repository with closed variables: counts, kinds, dates, the workspace name and Morrow links; never model output, mail, product text, names, amounts or customer data. Recipients are members' verified emails, each built from what that member may see. They are system sends with no approval and no credits. Each send is a row in a new content-free `mail_deliveries` table (ids, template id, recipient member id, key and status; no OperationLedger operation, so no taskless contract change), reconciled by item 5(a) and (b) with the same key, and never sent with a new key.
9. **Limits, custody and the switch.** The broker accepts only three recipient kinds: the thread's From address, the verified support address as Bcc, and a member's verified email. No supplier, marketing or bulk mail, and no Gmail or Outlook OAuth. It holds `RESEND_REPLY_KEY` and `RESEND_NOTIFY_KEY` (send-only, one domain each) and `RESEND_READ_KEY` (owner question 3), which never leave it. `docs/decisions/mail-staging.json` is committed `"off"`; while off, the handler rejects mail and the broker refuses sends. `support.reply.send` is refused until G10. Staging sends only to test and allowlisted owner addresses, under staging card 2. Defaults (owner question 5): 200 replies and 300 inbound runs per workspace a day; 5 hard bounces or 2 complaints in 7 days set a system stop on Support that only a person lifts.

## Security invariants touched

None is weakened.
- **Tenancy:** the tenant comes only from the envelope token (`lab:mail-inbound`, `lab:tenant-conformance`).
- **The intersection, re-checked at dispatch and before every replay:** `lab:mail-send`.
- **Digest-bound approval of customer messages:** eight fields; Bcc drift is a conflict (`lab:mail-send`).
- **Reconcile before retry:** `lab:mail-send`'s outcome table.
- **Broker-only credentials; fail closed:** `verify:boundaries`, `edge:check`.
- **`human_only` kill switches:** unchanged; the mail stop is a system stop (`stops.test.mjs`).
- **No agent effect before G10; no real mail before the `customer_mail` path (G9):** `edge:check`.
- **Immutable migrations:** `migration-history.test.mjs`.

## Consequences

- New provider resources: two Resend accounts, domain verification, DNS records and one Email Routing rule per environment, each an owner action or approved resource (G6, G7).
- Residual risks: the read key could change the Resend account if the broker were compromised; a spoofed From on a domain without DMARC passes, but the reply goes only to that address after approval; merchants share sending reputation.

## Alternatives considered

- **Gmail OAuth:** reads whole mailboxes. Later.
- **Postmark:** no idempotency key, so a lost reply cannot be closed by a replay.
- **Automatic resend after the key window:** a duplicate to a customer is the harm prevented here.

## Owner questions

1. **Sending identity.** *Recommendation:* Morrow's reply subdomain with the shop's name and the merchant as Reply-To at launch; the merchant's own domain as a fast follow.
2. **Domain, accounts and region (G7).** *Recommendation:* one Morrow domain on Cloudflare DNS, bought in W1; separate Resend accounts for staging and production; Resend's US region; the DPA signed before real mail. ADR-0031 cites this answer.
3. **The full-access read key.** *Recommendation:* accept it as a separate broker secret limited in code to fixed GET paths.
4. **The sender check.** *Recommendation:* Email Routing plus item 3 at launch; DKIM verification in the Worker after launch.
5. **Caps.** *Recommendation:* accept item 9's numbers as configuration.

## Approval

The owner's statement in chat, verbatim, on 2026-10-23 (IST), after reading the decision sheet (`docs/decisions/decision-sheet-2026-10-26.md`) and a plain-language list of its questions numbered 1 to 31, with the other decisions numbered 32 to 38, each with its recommendation (OD-2026-10-23-7):

> approve all as recommended and user should be able to select model and thinking effor for each agent with the main agent set to opus 5.5 high by default and specialist at opus 5.5 medium for email the shop owner should be able to link there emails which will be used for any particual email job like suppose user linked multiple emails(our morrow email will be linked by defualt with user shop name, something like usershopname@morrow.com and selected by default unless user link there emails) and then whenever any email sending related prompt comes user should be able to select which email to choose for that, for now no need to develop the actual capability to link the email but architecture wise it should be like how i explained so we can just add the feature to link users email and it will show in the emails available to use list.

What it approves: this record as written and each owner question above with its recommended answer.

The rest of the statement changes owner question 1: every email job picks its sender from the workspace's list of sending addresses, with the shop's Morrow address linked and selected by default; linking the merchant's own mailboxes is designed for but not built at launch. Item 10 records the change.
