---
id: Q-adr-0042-owner-questions
type: question
kind: decide
title: "The decision sheet for ADR-0042: connected services, customer contact and the COD confirmation agent, 20 questions with the lead's recommendations"
status: open
asked_of: owner
links:
  raised_by: [OD-2026-10-26-8, ADR-0042]
  about: [ADR-0042, ADR-0011, ADR-0022, ADR-0023, ADR-0025, ADR-0031, ADR-0035, ADR-0037, ADR-0039, F-order-and-money-writes, F-privacy-deletion, F-more-integrations, GATE-legal, GATE-deletion-paths, GATE-gateway-reservations-stops]
---

You asked whether a user could create an agent that calls a customer when a COD order arrives, to
confirm it, using their own calling service (OD-2026-10-26-8). The answer is yes, and ADR-0042
says how. Three separate reviews (security, legal and privacy, product) changed the draft before
it reached you, and a further review of the pull request corrected it. Each question below has one
recommendation. To accept them all, including the CLAUDE.md text shown in question 6, say "approve
ADR-0042 as recommended and the CLAUDE.md change", or answer by number. Nothing is built past the
records until you answer. The sources are in `docs/references/connected-services-and-contact.md`.

1. **Should services come only from a Morrow catalogue, connected with the merchant's own accounts?**
   - Options: (a) only catalogued services, each with a reviewed adapter; (b) also let merchants
     paste any API, webhook or MCP server.
   - Recommended: (a).
   - Why: (b) lets an agent or a pasted setting point Morrow at any address with any key. That
     brings leaked keys and no way to check whether a call went out. With (a), every service has
     typed actions, a check of what happened and a reviewed adapter. A missing service becomes a
     request, not a workaround.

2. **How are keys entered?**
   - Recommended: through a sealed form. Morrow's broker signs the form, with a signing key you
     place once and only the broker holds, and your browser checks the signature, then encrypts
     the key to the broker before it leaves the page, so Morrow's web server never sees it. Keys
     come from a sub-account with only the access Morrow needs. They are never shown again, only a
     short fingerprint, and account passwords are never accepted.
   - Why: it keeps the rule that only the broker ever holds a credential. MCP and the leading agent
     platforms forbid collecting secrets through a form an AI can see.

3. **Does each new service need its own short record that you approve?**
   - Recommended: yes, one page per provider: what is sent, where it is kept (including where its
     speech engines run), the adapter's guarantees and its test evidence.
   - Why: choosing a provider is material under CLAUDE.md. It is a new data flow and a new kind of
     credential.

4. **Which services first, and which do you use?**
   - Recommended: Plivo for calls (India data region) first. WhatsApp second, through the WhatsApp
     provider (BSP) the shop already uses, or Meta's Embedded Signup, once you tell us which. Please
     say which calling service and which WhatsApp provider you use.
   - Why: call audio for India must stay on servers in India; Twilio, Vapi and Retell numbers can't
     place these calls domestically; Plivo signs its callbacks and lets Morrow serve the script per
     call. At Plivo you would also set the limits it offers, such as calls to India only and call
     transfer and recording off, which limit what a fault or break-in inside Morrow could make a
     call do. Most Indian shops reach WhatsApp through a provider, and setting up the raw API means
     pasting developer tokens. WhatsApp also needs the customer's opt-in, which most checkouts don't
     collect yet.

5. **Scripted calls, or free-form AI conversations?**
   - Recommended: scripted, keypress only. The words are fixed and approved; a synthetic voice
     reads them; the customer presses 1 to confirm, 2 to cancel, 3 for a call back, 8 for "not my
     order", 9 to stop, 0 for the other language. No recording, no spoken answers and no product
     names in the first version.
   - Why: a free-form AI voice would say things nobody approved, could be steered by what callers
     say and would bring in another AI provider, for a yes/no question. Recording and spoken answers
     add customer data and unconfirmed data locations; whoever answers the phone would hear a
     product name, which matters for health products.

6. **Can one approval of an exact call plan cover every call it makes?**
   - Recommended: yes. You approve the exact words, numbers, hours, tries, tags and limits once, by
     typing a phrase; each call is then checked in code against the plan, the stops, the hours, the
     stop list and the limits, with no tap per call.
   - Why: a COD confirmation has to happen within minutes, and a tap per order doesn't work.
   - What it changes. This relaxes one of Morrow's security rules, so please read it closely:
     - "Approvals are bound to a digest of the exact proposal" stays true, but one approval now
       covers many calls and the tags they lead to.
     - "Any edit invalidates them" changes for plans: when a plan is edited, the old version keeps
       calling under your earlier approval until you approve the new one, unless whoever edits it
       chooses to pause it meanwhile. Every other approval is still voided by any edit.
     - ADR-0035 item 4 (ask you before each send to your customers) and item 5 (agents change the
       store or message a customer only after you approve the exact change) change the same way.
     - Your OK in chat is still needed, once, before the first real customer is called.
   - The exact CLAUDE.md text. A "yes" approves these four edits word for word, as you approved
     ADR-0035's lines (OD-2026-10-23-10); CS2 commits them as shown and changes nothing else in
     CLAUDE.md.
     1. Security invariants.
        - Now: "Approvals are bound to a digest of the exact proposal. Any edit invalidates them. The
          gateway re-checks authority before execution."
        - Proposed: "Approvals are bound to a digest of the exact proposal. Any edit invalidates
          them. The gateway re-checks authority before execution. One exception (ADR-0042): an
          approved customer-contact call plan is one exact proposal whose approval covers each
          contact and order tag it names; an edit to a plan makes a new revision that needs its own
          approval, and the approved revision keeps running until then unless the editor pauses it."
     2. Security invariants.
        - Now: "The owner's own store is the only real store until the public launch, and Morrow is
          built and tested on it (ADR-0035). Agents change it only through an approved exact
          proposal. Local and CI tests use fakes; only the deployed environment reaches the store."
        - Proposed: "The owner's own store is the only real store until the public launch, and
          Morrow is built and tested on it (ADR-0035). Agents change it only through an approved
          exact proposal, or by adding an order tag that an approved call plan names (ADR-0042).
          Local and CI tests use fakes; only the deployed environment reaches the store."
     3. Provider and live effects.
        - Now: "Ask the owner first, every time: purchases, plan upgrades and ad spend; raising a
          cap; deleting data; sending anything to the owner's customers; the App Store submission;
          any store other than the owner's. Accepting a provider's terms and anything that needs the
          owner's own login stay the owner's."
        - Proposed: "Ask the owner first, every time: purchases, plan upgrades and ad spend; raising
          a cap; deleting data; sending anything to the owner's customers, except that under an
          approved call plan the owner's OK in chat is asked once, before the first live day, and
          the plan's approval then covers each contact (ADR-0042); the App Store submission; any
          store other than the owner's. Accepting a provider's terms and anything that needs the
          owner's own login stay the owner's."
     4. Provider and live effects.
        - Now: "Change the owner's store only through Morrow's own flow: the owner approves the
          exact change in the workspace, and the gateway applies, reads back and audits it. Never
          write to the store any other way."
        - Proposed: "Change the owner's store only through Morrow's own flow: the owner approves the
          exact change, or the call plan that names it (ADR-0042), in the workspace, and the gateway
          applies, reads back and audits it. Never write to the store any other way."
   - Not changed: the customer-data rule ("Customer data … never enter before their P09.T05
     deletion and privacy path exists"). Question 8 covers the phone field.

7. **Which agents may make these calls?**
   - Options: (a) only Morrow's own COD Confirmation teammate in the first version; (b) also agents
     Morrow drafts from scratch on an agent card.
   - Recommended: (a).
   - Why: there is one purpose and the words are Morrow's own, so a card drafted "from the same
     presets" would be the same teammate. You still ask in your own words, and Morrow sets it up
     from what you say. (b) can come with a second purpose or merchant-written words; it would amend
     ADR-0037 item 5.

8. **Which customer data from Shopify?**
   - Recommended: the Phone field only. It is never stored in readable form, never shown and never
     given to any AI; it is read at dialling and kept only as a keyed fingerprint for the stop list
     and limits. The call log is still treated as personal data in your notices.
   - Why: minimum data is Shopify's first rule, and each field is reviewed separately. Names aren't
     needed for "your order 1042". If Shopify also requires the Address field to read a shipping
     phone, you will be asked again.
   - What it changes: ADR-0035 items 3 and 7 say customer data comes last, with the Support agent.
     A "yes" lets the phone field come earlier, for COD Confirmation only, and still only after its
     deletion path is in place. CLAUDE.md's customer-data rule does not change.

9. **May the plan tag orders in Shopify?**
   - Recommended: yes. Shopify asks you for `write_orders` during setup. The plan adds one of three
     tags (`morrow-cod-confirmed`, `morrow-cod-cancel-requested`, `morrow-cod-unconfirmed`), never
     replacing yours, and reads each one back. Orders held back for measuring get no tag.
   - Why: your warehouse can act on the tags ("ship confirmed, hold cancel-requested, decide
     unconfirmed"). Adding a tag can be undone.

10. **Who cancels?**
    - Recommended: always a person. A customer's "cancel" becomes a cancellation proposal in your
      Inbox and the Shopify admin's Morrow page; you can approve up to 50 at once. Shopify's
      cancellation email to the customer is off unless you turn it on. No answer never leads to a
      cancellation.
    - Why: cancelling can't be undone, and customers who simply missed a call shouldn't lose their
      order.

11. **India's calling rules: how far may calls go before a lawyer confirms them?**
    - Options: (a) transactional window only: two calls, about 1 and 12 minutes after the order,
      both within 30 minutes, where TRAI's rules need no consent; orders placed when no call can
      start in time (from about 9 pm, and at night until shortly before 9 am) are not called and
      go on the morning list.
      (b) Also, on your store now, a third call 2 hours later and calls for night orders the next
      morning.
    - Recommended: (a), until counsel answers.
    - Why: (b) rests on reading those calls as delivery-information calls. If TRAI reads them as
      calls that help complete the purchase, they need consent recorded through DLT, and 3
      complaints in 10 days can bar your phone lines. In both options you attest that your numbers
      are declared for automated calls and that caller ID shows your shop's name; other countries
      stay closed; a lawyer confirms before any outside merchant.

12. **One setup approval, and a test call to your own phone?**
    - Recommended: yes. Setup is a 3-step guide (connect your calling service, allow tagging, hear
      it and approve). You add your own phone as a test number: Morrow calls it once with a 6-digit
      code, which you type back, so only a phone you hold can be a test number. "Call me now" then
      rings it with the exact words for a recent order.
      Then one review covers the teammate and its first call plan, with one phrase, "add COD
      Confirmation and approve calls for up to 200 COD orders a day", and one 5-minute wait.
    - Why: separate approvals would mean two phrases and two waits for one job. The two stay
      separate records underneath, so editing either needs a new approval.

13. **How long is contact data kept?**
    - Recommended:
      - the per-call log, which holds no call words or phone numbers, for 90 days, like other
        customer data in Morrow; the daily list of orders to check and the call-back tasks expire
        with it and go when a customer asks to be deleted; daily counts with no order link for 365
        days;
      - an opt-out, as a fingerprint only, even after a customer's deletion request, so they are
        never called again; a lawyer confirms this against Shopify's rules before outside merchants.
    - Why: deleting an opt-out would bring back calls to someone who said stop. India's one-year log
      rule is not in force until about May 2027 and binds the shop; counsel decides before then.

14. **The safety values.**
    - Recommended: as in ADR-0042's Values table:
      - 09:00 to 21:00 IST at most;
      - per phone number, 3 contacts in any 24 hours and 6 in any 30 days;
      - 200 COD orders a day per plan by default, at most 2,000;
      - an automatic stop on high opt-out or wrong-number rates, abandoned or silent calls, a burst
        of failed calls, or a spam flag reported by the provider or by you.
    - Why: phone companies flag and bar numbers that call like spammers, and fake orders could
      target someone else's phone.

15. **Measure the effect?**
    - Recommended: yes. Hold back 10% of COD orders, not called and not tagged. The share stays at
      10%, at setup too, until about 300 of them have settled. You pick the tag or status your
      courier app writes for a returned parcel. Each week the report shows confirmations and
      cancellations at once, and returned parcels for settled weeks, with "Too early to tell" until
      the numbers are clear. Then you set the share, from 0 to 30%.
    - Why: vendors claim 15 to 45% fewer returns, but no independent study exists, and returns
      take 1 to 3 weeks to show up. This shows what it does for your store.

16. **Credits for calls?**
    - Options: (a) calls are counted but not charged until rate card v1; (b) each call costs credits
      from the start.
    - Recommended: (a). You pay the calling service directly. The teammate's AI work costs credits
      as usual.
    - Why: no AI runs on the call itself, so Morrow's own cost is small, and an empty balance should
      never silently skip a time-critical call.

17. **A general "when an order event happens" trigger for every agent?**
    - Options: (a) later, by its own change; (b) now.
    - Recommended: (a).
    - Why: the COD plan only needs its own order filter. Other agents can gain it later without
      slowing this down.

18. **Who is responsible for the calls?**
    - Recommended: the shop is the caller and decides what happens to its customers' data; Morrow
      acts for it. Before any outside merchant, a lawyer drafts a merchant agreement and contact
      terms (no offers on calls or call backs; notice and registrations done; Morrow tells the shop
      of a breach within 24 hours). Morrow gives every shop ready notice text for its privacy policy
      and checkout. Morrow never uses call data for itself.
    - Why: India's and Europe's data laws require a contract between a business and anyone
      handling its customers' data for it, and customers must be told at checkout.

19. **A "Stop customer contact" switch?**
    - Recommended: yes. Any Owner or Admin can stop all customer calls in the workspace at once,
      with no second approver. Calls already ringing are hung up; a call answered just after hears a
      short approved goodbye. Restarting is reviewed for each call plan and covers only new orders
      unless you choose otherwise; lifting any stop, the workspace stop of ADR 0040 included,
      restarts no plan by itself.
    - Why: "Stop AI work" stops one agent; this stops every call, the way the existing stops work.

20. **When?**
    - Recommended: build it now as its own lane, with switches off. "Call me now" works once the
      gateway and its stops are in place. Real customers are called after the customer-data
      deletion path is in place, Shopify grants the phone field and you give your OK in chat, once,
      before the first live day. It is
      in launch scope if ready by G17, otherwise the first fast follow, and it never holds launch.
    - Why: you asked to build the full product in parallel. The gates protect your real customers.
