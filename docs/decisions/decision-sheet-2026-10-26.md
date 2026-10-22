# Decision sheet, week 0 (2026-10-26): ADR-0023's companion records

The weekly decision sheet (ADR-0023 decision 10). Eight companion records, [ADR-0024 to ADR-0031](adr/README.md), are proposed. Each is material under ADR-0002, and no code that depends on one merges before your approval. Production custody (due by W5) and the live-store ADR come on later sheets. "The Owner" below is the workspace's designated owner, at launch its founding principal.

## ADR-0024 Proactive authority

Decides:
- Each installed agent works under a 90-day mandate built in code from live facts, renewed by a person, never automatically, with notices at 14 and 3 days.
- A proactive run's requester is the installation; a solo owner still types the confirmation, and a team installer may approve their own agent's proactive work.
- `workspace.routine.revoke` (`human_only`, credit-free) ends a mandate at once; a "Take over" step when an installer leaves.
- Only one definer admits proactive runs and issues their leases; triggers that are not admitted wait and are never dropped; look-for-work is read-only, once a day, under a cap.
- An edit makes the editor the author; one typed confirmation per solo batch of 2 to 50; a 4-hour "approval waiting" email from a fixed template; one automatic re-draft of an expired proposal.
- Accepted as looser: a compromised orchestrator could admit due mandate runs, within caps and producing only proposals.

Questions:
1. Team installs and mandates without a second reviewer: (a) always, (b) only while no other member holds the store grants, (c) never. A material authority change beyond ADR-0023. **Recommended: (b).**
2. Should internal proposals also send the 4-hour email? **Recommended: no.**
3. Automatic re-drafts per expired proposal? **Recommended: one.**

## ADR-0025 Shopify public app

Decides:
- One merchant-facing public app (`morrow`) and a never-submitted development app (`morrow-staging`); no custom apps.
- Install starts on Shopify; linking happens in the standalone workspace, and only the Owner links.
- The embedded home holds only setup, connection status, plan and pending approvals.
- Session tokens are verified by the broker; expiring offline tokens stay in the broker vault, one refresh at a time, and an unknown refresh is reconciled once, then "reconnect needed".
- Five required scopes and per-agent optional scopes; product, inventory and (with `read_orders`) order webhooks, minimised and kept 7 days.
- Store-link template v2: each optional scope gives the Owner the matching capabilities with `delegate`.
- Level 1 order reads for the Analyst and Inventory; Level 2 name and email for Support only.

Questions:
1. May members approve or reject from the embedded home? **Recommended: yes,** with the same digest-bound documents and typed confirmation.
2. Embedded member session length? **Recommended: ADR-0004's limits,** 30 minutes idle and 12 hours absolute.
3. When to list the app? **Recommended: unlisted at launch;** listing decided after 30 clean paid days.
4. May the embedded home engage "Stop AI work"? **Recommended: no;** it links to the workspace (yes would amend CLAUDE.md).

## ADR-0026 Billing and price

Decides:
- Shopify App Pricing only: one monthly plan and one usage meter for extra credits; Stripe stays switched off.
- Plan credits only after Shopify shows a paid cycle; extra credits in blocks, granted only after Shopify confirms the usage record; an unknown block is never promoted.
- Caps in code: the extra-credit cap defaults to 0 and only the Owner raises it; per-agent and workspace caps; look-for-work at most 1% of the grant per pass; specialists at most 5% per run and 20% per workspace per day.
- A versioned rate card replaces one credit per product; stops and revoke are free; failed runs cost 0.
- Development stores run paid work under an owner-run `TestEntitlementSeed` (T13's first PR, by W3; the G11 path); 0035's operator test entitlement retires.

Questions:
1. Price? **Recommended: US$149 a month,** provisional, confirmed by W8 from staging measurements.
2. Rollover? **Recommended:** plan credits carry over one cycle; block credits last while subscribed.
3. Blocks? **Recommended:** 20% of the grant at the plan's price per credit; default cap 0; ceiling twice the plan price per cycle.
4. Margin? **Recommended:** vendor cost at most 50% of net revenue per credit, at a 17.9% fee.
5. If Shopify rejects blocks (G8)? **Recommended:** ask for the Billing API and keep building.
6. USD backstops? **Recommended:** keep US$7 per run and US$25 per workspace per day until staging measurements justify new values.

## ADR-0027 Agent loop and model

Decides:
- One `AgentRunWorkflow` with tools for installed agents, the Coordinator and specialists; each tool call is a durable step with the authority check for its run kind and a credit hold.
- A closed, generated tool catalogue; no tool has an external effect, and proposals go to the gateway.
- `ModelCall@2` with an append-only conversation that the broker enforces.
- The untrusted-content rule for P11.T02: a tainted proposal is dispatched only after a person approves its exact digest, and its card lists its sources.
- The Coordinator is model-based with a small fixed grant set: no store, support or customer data, and only a person starts it.
- Model profiles are set at install; the model may pick a specialist's skill ids, which never change its tools or capabilities (refines ADR-0023 11a).

Questions:
1. Default profiles: Sonnet 5.5 at low effort everywhere; packages may allow Haiku, Sonnet or Opus 5.5 at low or medium. **Recommended: approve.**
2. Loop limits: 64,000 input tokens a turn, 16 turns, 4 and 40 tool calls, 30 and 5 minutes, `max_tokens` 5,000 and 12,000, 8 KiB results. **Recommended: approve,** confirmed against staging measurements.
3. Prompt caching of the fixed prefix for 5 minutes. **Recommended: approve.**

## ADR-0028 Specialist authority

Decides:
- Each Start creates a run-scoped `task_specialist` installation, owned by the Owner, under a fixed SQL ceiling: no orders, customer data, support tools, delegation or approvals.
- One digest-bound Start document (standalone sessions only) and one Start transaction that reserves the full cap and creates everything.
- Start replaces stage-and-activate for this kind only; installed agents keep it.
- One 24-hour authority clock; the run lasts 1 hour by default and 8 at most, its lease renewed every 30 minutes while every check holds.
- Input refs to customer data or uploads are refused; deletion goes through ADR-0031's registry.

Question:
1. The workspace setting's default once specialists are switched on? **Recommended: on,** and the Owner may turn it off.

## ADR-0029 Runtime and E2B

Decides:
- One fresh E2B sandbox per run that needs it: internet off, no credentials, no browser, killed at run end.
- A provider-neutral port in the broker; unknown outcomes reconciled, never retried blind; a runtime hold that only a person lifts.
- Minimised inputs with no customer data or URLs; only PNG, CSV or XLSX downloads out; uploads opened only in a sandbox, never by a specialist at launch.
- A new `runtime.execution.use` capability, a worst-case reservation, and a Morrow runtime budget below E2B's limit.
- The switch is committed off and stays `synthetic_only` until G9, E2B's DPA and acceptable deletion answers.
- Accepted as looser: a compromised orchestrator could learn which runtime operations are unsettled, but no content.

Questions:
1. Template builds: your interactive E2B login, else one build-only key in a chmod-600 file you hold. **Recommended: yes, in that order.**
2. Buy Pro at production bring-up (W7 to W9)? **Recommended: yes** (amends ADR-0023 decision 6's timing).
3. If E2B has not answered by 2026-11-20, start the adapter with conservative defaults? **Recommended: yes** (amends the G5 rule).
4. Is E2B's sandbox token, unreadable by Morrow's code, outside the invariant that no credential enters the VM? **Recommended: yes.**

## ADR-0030 Email

Decides:
- Inbound support mail by forwarding to a per-workspace address on Cloudflare Email Routing; mail is untrusted data.
- Support replies only, after approval of the exact digest, through Resend with one idempotency key per send; unknown outcomes are reconciled and never resent with a new key.
- Every reply is plain text, with Bcc and Reply-To set to the merchant's verified support address.
- Notifications are fixed templates, logged in a content-free `mail_deliveries` table.
- Only Support declares `support.*`; three broker-held Resend keys; the switch is committed off, and sends are refused until G10.

Questions:
1. Sending identity? **Recommended:** Morrow's reply subdomain with the shop's name at launch; merchant domains as a fast follow.
2. Domain, accounts and region (G7)? **Recommended:** one Morrow domain bought in W1, separate Resend accounts, Resend's US region, the DPA before real mail.
3. The full-access read key? **Recommended: accept,** limited in code to fixed reads.
4. The sender check? **Recommended:** Email Routing at launch; DKIM in the Worker after launch.
5. Caps? **Recommended:** 200 replies and 300 inbound runs a day per workspace; a stop at 5 bounces or 2 complaints in 7 days.

## ADR-0031 Data

Decides:
- 90-day clocks for customer mail, order data, run turns, notebooks, uploads and sandbox outputs; content-free records 365 days; webhook receipts 7 days.
- Customer data lives only on 90-day clocks and reaches only Support's runs: never the Coordinator, a specialist, E2B or a notification.
- One deletion registry for every class, each path merged before real data (G9); a privacy request completes only when everything, sandboxes included, is proven gone; `data_request` exports go to the Owner only.
- Per-viewer read tags on every shared item; hidden items are left out.
- Data regions in one checked file that generates the privacy policy's table.

Questions:
1. Retired specialist authority rows? **Recommended:** keep them, content-free, while referenced, and at the latest until redaction, uninstall or erasure.
2. Reinstall within 48 hours? **Recommended: delete anyway.**
3. A workspace with no store and no plan? **Recommended: erase it after 90 days,** with notices at 30 and 7 days.
4. Who reads customer data by default? **Recommended: the Owner only.**
5. Merchants outside the US? **Recommended: accept them** once counsel confirms at G16.

Reply 'approve all companion ADRs as recommended' or name the items to change
