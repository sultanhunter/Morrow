# ADR-0023 MVP redefinition: a lean, full-featured workspace where a shop's people and AI agents run the business together

- Status: Accepted 2026-10-23 (owner decisions in chat; see Approval). Decisions 1 to 10 were approved with their recommended options ("yes to all recommended", Q12). Decision 11 (specialists) and billing option A, which amends decision 5 and the embedded part of decision 2, were approved the same day ("yes to both, go with option A and specialists", Q14). The rest of this record is written from those answers. The owner accepted the record as written on 2026-10-23 ("approve ADR-0023 and the CLAUDE.md lines", see Approval).
- Date: 2026-10-23 (drafted 2026-10-22; revised 2026-10-23 for the approvals, the owner's addition to decision 1, decision 11 and billing option A)
- Supersedes:
  - ADR-0021 item 1 (the invite-only listings beta as the launch target);
  - ADR-0021 item 4 (the list deferred past launch), except its last sentence: the 18 packages, 80 parent tasks and 73 acceptance IDs stay the long-term structure and are not the launch gate;
  - ADR-0021 item 6 (Stripe-only billing at launch);
  - the beta scope of `docs/plan/mvp.md` (the M1 to M6 path);
  - the CLAUDE.md constraint "MVP fast track (ADR-0021): launch the invite-only product-listings beta in `docs/plan/mvp.md` first".
- Amends:
  - ADR-0001, as refined by ADR-0021: the launch plan is this record with `docs/plan/mvp.md`; once the project graph lands, its feature, agent, track and gate nodes carry the plan and `mvp.md` becomes generated (decision 10). `build-plan.md` stays the long-term plan of record;
  - the CLAUDE.md standalone-workspace constraint: it adds a minimal embedded home in the Shopify admin (setup, connection status, plan, pending approvals); "No embedded domain workspace in this release" stays (decision 2, as option A amends it);
  - ADR-0015: Shopify App Pricing is the only billing route at launch; the Stripe route stays built and switched off (decision 5);
  - ADR-0011 Q1 and ADR-0022, item by item, only through the companion records listed below, each before its dependent code.
- Refines: ADR-0002 and ADR-0003 (process, decision 10).
- Does not change:
  - ADR-0005 (kill switches stay `human_only`);
  - ADR-0007 item 9 (production custody needs its own ADR, now due by week 5);
  - ADR-0010 and ADR-0020 (tenancy and the migration administrator);
  - ADR-0014 (merge authority and the trunk);
  - any security invariant (see "Security invariants that do not change").
- Affects: CLAUDE.md (the settled constraints; session step 1 once the graph command merges; the intro, session step 3 and the Delivery flow's PR rule once the owner approves their wording, see Consequences); `docs/plan/mvp.md`; the launch-order notes of `docs/plan/build-plan.md`; `docs/progress/STATUS.md`; `docs/briefs/mvp-architecture.md` and the M2 to M5 briefs (their beta framing; their designs are reused); `docs/decisions/providers.json` (through the companion records).
- Number: an earlier draft for testing on the owner's live store used the number ADR-0023. It was never committed, and decision 2 supersedes it.

## Context

On 2026-10-22, with E2B chosen and the merge train still open, the owner wrote, in chat (Q10):

> the purpose of using agent vm/runtime was to create a ai workspace with humans & agents that work proactively with the specified goal(like grok bot, dots etc.) plus ability to intall premade agents given by platform itself(us). why we are deteroung so much from our main goal of the product? so its better that we re analyze what we are building, the best way to build it, what we have achieved yet and the path forward to our mvp. also one more thing i want to introduce some sort of graph method for persisting all the knowledge and progress we do on our project instead of using mutliple .md files that are not linked to each other.

Earlier that day the owner had asked for an agent runtime in the MVP and chose E2B ("lets make sure we do have agent runtime in our mvp", Q2; "okay go with e2b", Q3; "no sorry i selected the wrong version, i do want the e2b in our mvp", Q4), and declined to move the release date because many agents can build in parallel ("we don't need to push the release as we have all the agents at our disposle as we are using opus ultracode we just can run the work in parallel it will take the same amount of time", Q5).

The re-analysis found:
- **The destination never changed.** `build-plan.md` already has goals, mandates, schedules, installable Morrow agents, E2B, knowledge and an Inbox. ADR-0021 narrowed launch to one request-driven job, and the proactive heart of the product was deferred with it.
- **The temporary specialist was in the original design and had been dropped.** `docs/references/skills-and-agent-store.md` line 43: "A temporary specialist run stays within the existing task; a recurring employee requires an installation and an authorized mandate" (plan IDs P13.T02, P15.T04 and P16.T02).
- **Shopify's rules, checked 2026-10-22 and 2026-10-23, rule out the beta's path:**
  - one custom app per merchant is not allowed at scale, and duplicate apps break the Partner Program Agreement ([staff answer](https://community.shopify.dev/t/unlisted-shopify-app-review-required-before-installation/33101));
  - an unlisted public app follows the App Store rules, billing included: requirement 1.2.1, "Apps that use off-platform billing cannot be distributed through the Shopify App store" ([requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements));
  - a public app that is not yet approved installs only on development stores ([staff answer](https://community.shopify.dev/t/testing-app-without-being-approved/32009));
  - new public apps must use expiring offline tokens: a 1-hour access token and a 90-day refresh token ([offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens));
  - `shopifyqlQuery` needs `read_reports` and Level 2 customer data ([ShopifyQL](https://shopify.dev/docs/api/admin-graphql/latest/queries/shopifyqlQuery));
  - requirement 3.2 asks for only the necessary scopes, with optional scopes for the rest ([scopes](https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes));
  - requirement 2.2 asks for an embedded experience; a staff post says fully non-embedded apps are allowed, and a sign-in-and-billing-only shell fails review (community threads 27111 and 33847);
  - a merchant who pays on the app's own website before installing may stay on that billing; anyone arriving from Shopify is billed only through Shopify (staff, community threads 32868, 35728 and 36909). That is ADR-0015's split.
- **The trust layer is strong:** tenancy, the authority kernels, approvals, custody, leases and deploys. The gateway's apply path, mandates, the deletion paths for new data classes, embedded identity, token refresh, production and the agent loop are still to build.

After the re-analysis the owner wrote, on 2026-10-22, in chat (Q11):

> okay then drop this beta launch, we are going to launch mvp but with full fledged feature list that makes the Morrow a good and lean ai worspace for shop owners to run there ecommerce business with humans and ai agents together.

On 2026-10-23 the owner approved decisions 1 to 10 and asked about sub-agents (Q12, quoted under Approval), then asked why billing moves to Shopify (Q13):

> okay now why we migrating away from stripe and going through shopify app store pruchase why not we make the shopify plugin free and user pay on our website for the plan

The answer: a free app with website-only billing needs a written exemption from Shopify, which staff say a SaaS that owns its billing usually does not get (community thread 37159, 2026-09-02; an app was paused under 1.2.1 in August 2026). Shopify billing is required for merchants who arrive from Shopify, and costs a 2.9% fee with no revenue share on the first US$1M of lifetime revenue (15% after). On Stripe, Morrow is the seller and files sales tax and VAT itself, and Stripe accepts Indian businesses by invitation only. Option A keeps Stripe's code switched off so ADR-0015's split stays available. The owner approved option A (Q14).

The detail behind this record was prepared in working papers outside the repository: the redefined MVP (revision 3), the specialists design (revision 2), the billing comparison, the merchant jobs and market research, and the knowledge-graph proposal. The redefined MVP and the specialists design each passed an AI review (separate context, same model family), and the billing comparison was fact-checked against its sources. This record and `docs/plan/mvp.md` carry what was decided; the specialist authority packet restates the design it implements.

## Decision

Morrow launches as a paid, lean but full-featured AI workspace where a Shopify shop's people and AI agents run the business together. Each numbered item below is the owner's decision of the same number, with the option the owner approved.

1. **Scope.** Approved 2026-10-23 with the recommended option and the owner's addition (Q12).
   - **Proactive agents.** Agents work toward standing goals on their own: schedules in the shop's timezone, routines people set, recurring tasks, Shopify events, metric monitors evaluated in code, mentions and assignments, and a daily read-only look-for-work pass under a small cap. Each installation keeps a notebook. Admission control in code gates every run.
   - **Shared work.** People and agents share goals (metrics computed in code), a task board, a thread on every task, one Inbox, artifacts and CSV/XLSX uploads, a shop knowledge base of typed pages with full-text retrieval, notifications with a daily digest, and an activity log. Roles are Owner, Admin and Member, with per-viewer visibility; authority follows explicit grants, never a title.
   - **Installable agents.** The merchant installs premade agents that Morrow makes and publishes, from a catalogue: AgentPackage@1, built from first-party skill files plus a role prompt, released through the existing release gate with recorded evals in CI and a passing live-eval digest from staging. Install, pause, update to a pinned release and uninstall.
   - **Launch agents.** The built-in, model-based Coordinator, and five installable agents: Listings, Business Analyst (owns the daily pulse and weekly review), Inventory and Purchasing, Customer Support, and Marketing and Promotions. The floor is the Coordinator, Listings, Analyst, Inventory and Support.
   - **The Coordinator** answers from knowledge, routes Asks and @mentions to one installed agent, asks clarifying questions and ranks suggestions. It creates only tasks, questions, messages and specialist drafts. It is separate from the optional Chief of Staff and CMO, which stay after launch. Agent titles and delegation never confer authority.
   - **The owner's addition (Q12):** "one hop" becomes **one level of specialists under the Coordinator**. The Coordinator may propose a temporary specialist for a task, a person starts it, and specialists cannot start specialists. Decision 11 sets its form.
   - **Effects.** Internal work runs freely. Every store change, discount and customer message needs a person's approval of the exact proposal. Merchants can tighten rules, never loosen them. Automatic apply comes later, by its own ADR.
   - **Proactive defaults:** 90-day mandates, per-agent daily and monthly caps, quiet hours, one look-for-work pass a day, recurring tasks.
   - **Slip order:** Marketing first, then Inventory's computer forecast (it falls back to TypeScript). Support stays unless Shopify refuses Level 2 access. The skill files ship either way.
2. **Distribution.** Approved 2026-10-23 with the recommended option (Q12); its embedded part as billing option A amends it (Q14).
   - One public app record, unlisted first, then listed. App Review is on the launch path. No custom app per merchant, and none for the owner's store.
   - **The standalone workspace stays the product.** In the Shopify admin, Morrow shows a small, real embedded home: setup, connection status, plan, and pending approvals, with App Bridge and session tokens. Shopify's guide for integrating large apps describes this pattern ([integrating](https://shopify.dev/docs/apps/build/integrating-with-shopify)). If App Review objects under requirement 2.2.2, the embedded surface grows toward full embedding (unestimated); that would be a new owner decision.
   - All building and testing happen on development stores.
   - The owner's store becomes the first real install after App Review approval, under its own live-store ADR with approval per action. Never for development. This replaces "Our live store" (2026-10-21) and "Wait for live store" (2026-10-22): an unapproved public app cannot install on a live store.
   - Production is up before the App Review submission.
3. **Review rules for proactive work.** Approved 2026-10-23 with the recommended option (Q12). The Proactive authority companion record amends ADR-0011 Q1:
   - the requester of a proactive run is the installation itself; a person who asks or @mentions is still the requester of that run. The installation owner's current authority stays in the intersection, so no authority widens;
   - whoever edits a proposal becomes its author;
   - a solo owner types one confirmation per batch;
   - "approval waiting" emails go out after 4 hours, as fixed templates;
   - expired drafts are drafted again from fresh data, never revived.
4. **Shopify data and credentials.** Approved 2026-10-23 with the recommended option (Q12).
   - Expiring offline tokens, under a credential-custody security packet: the refresh token lives only in the broker vault; one refresh per shop at a time under a lease, never a refresh and a fresh acquire together; each refresh is a ledgered provider effect; a lost refresh reply is an unknown outcome, reconciled once with the same refresh token, then a "reconnect needed" Inbox item, never a retry loop; a weekly refresh keeps idle shops inside the 90-day window. This replaces ADR-0022 decision item 4's non-expiring token.
   - Required scopes stay minimal (`write_products`, `read_inventory`, `read_locations`, `read_legal_policies`, `read_online_store_pages`). The rest are optional and requested when the agent that needs them is installed: `write_files` (Listings), `read_orders` (Analyst, Inventory, Support), `read_customers` and `read_returns` (Support), `write_discounts` (Marketing). They are revoked when no installed agent needs them.
   - Analyst and Inventory use Level 1 order reads and webhook totals. No ShopifyQL at launch.
   - Level 2 (name and email only) for Support, requested in the first submission.
   - 60 days of orders at launch; `read_all_orders` after launch.
5. **Billing and price.** Approved 2026-10-23 with the recommended option (Q12), as billing option A amends it (Q14).
   - **Shopify App Pricing at launch:** a recurring plan with a monthly credit grant, plus usage charges for extra credits, with caps that Morrow enforces (App Pricing has no usage caps or one-time credit packs). The Billing API is used only if Shopify agrees Morrow needs it.
   - Credits are granted only after Shopify confirms a usage record. A usage record is a money effect: it goes through the operations ledger with an idempotency key, and an unknown outcome is reconciled before any retry and grants nothing.
   - A rate card replaces "one credit per product". The plan sits around US$99 to US$149 a month (the owner's number), re-run against always-on agents and computer time. Shopify's 2.9% fee is in the model, with no revenue share on the first US$1M of lifetime revenue, then 15%.
   - **M5's Stripe code stays, switched off** (`docs/decisions/stripe-staging.json` has `switch` committed `"off"`); it is not retired. Switching it on needs an owner decision. ADR-0015's split stays available for website-first payers: a merchant who pays on the Morrow website before installing may stay on Stripe, and a merchant who arrives from Shopify is billed only by Shopify and never reaches Stripe.
   - The wallet, reservations and entitlements stay the authority for spend.
6. **Runtime.** Approved 2026-10-23 with the recommended option, without the pull-forward (Q12).
   - At launch: one fresh E2B sandbox per run that needs it, at most one per run, with no internet, no credentials and no browser, killed at the end of the run. Used for analysis, forecasting, charts and opening uploaded spreadsheets. Uploads are opened only there.
   - Inputs are minimised extracts the broker stages; never customer names, emails or addresses. The VM never receives R2 or presigned URLs. Outputs are untrusted data, returned only as PNG, CSV or XLSX, checked by content and served as downloads. A manifest that declares both customer reads and computer tools is refused in CI and at install.
   - A ledger, an orphan sweep and reconciliation before any retry. If E2B is off, computer tools answer `computer_unavailable`, Analyst and Inventory use TypeScript fallbacks, and uploads wait.
   - Next, after launch: a lasting paused workspace per agent, and allowlisted public web access through Morrow's own proxy, never sign-ins.
   - Hobby for staging, Pro at launch. If E2B is not qualified at launch, the owner chooses between the TypeScript fallbacks and holding launch; never automatic.
   - E2B's written answers (the questions were sent right after Q12, at about 18:41Z on 2026-10-22) block adapter code only.
7. **Agent loop and model.** Approved 2026-10-23 with the recommended option (Q12).
   - A multi-turn loop with tool use, generalising `ListingsRunWorkflow` into one `AgentRunWorkflow`. Each tool call is its own durable step with the effective-authority check and a credit reservation. This changes `ModelCall@1` and ADR-0022 decision item 10 ("never sent: tools"), through the Agent loop and model companion record.
   - Each agent gets a model profile from the catalogue, set by the Owner or an Admin at install. This replaces the per-run model choice of ADR-0022 decision item 16; the versioned catalogue stays.
8. **Email.** Approved 2026-10-23 with the recommended option, Resend (Q12).
   - Inbound support email by forwarding to a Morrow address (Cloudflare Email Routing).
   - Outbound support replies only, after approval, through a vendor with idempotency keys and a message-status API: Resend, subject to its DPA. A copy (BCC) goes to the merchant. After the key window an unconfirmed send needs a person, never an automatic resend.
   - No supplier email (Morrow drafts; the merchant sends). Notification emails are fixed templates. No Gmail OAuth at launch.
9. **Data, retention, visibility and regions.** Approved 2026-10-23 with the recommended option (Q12).
   - 90 days for the new data classes (customer mail, order aggregates, sandbox files, run turns, uploads, notebooks), deleted on uninstall or redaction. Each class has its deletion path before real data of that class arrives.
   - Per-viewer visibility: every shared item carries the read permissions it was built from, and the api filters it for each viewer.
   - The privacy policy names the data regions: Neon us-east-1, Workers placed in us-east-1, E2B US-WEST-1 (to be confirmed), Anthropic's global routing, and the email vendor's region (to be checked).
   - This ends ADR-0022's "customer data never stored", through the Data companion record.
10. **Process and the graph.** Approved 2026-10-23 with the recommended option: stay on the agent merge lane for now (Q12).
    - **The plan.** The launch plan is this record with `docs/plan/mvp.md`. The project knowledge graph (Q10) is adopted in phases: the engine (phase 0), the MVP as nodes, headers in place with `graph:check` replacing `plan:check`, then a generated STATUS. `mvp.md` then becomes a generated page. `build-plan.md` stays the long-term roadmap; its IDs become aliases on graph nodes. No graph database and no new provider.
    - **CLAUDE.md** changes the MVP constraint, the embedded line and the billing line with this record. Session step 1 changes to the graph's status command when that command merges.
    - **Briefs and packets.** One-page brief per track. Full packets only for the gateway, session-token identity, expiring-token custody, mandates, E2B, deletion paths, billing, the review-rule change and specialist authority. No new acceptance tables for launch work; a brief's checklist (and later the graph nodes) carry acceptance.
    - **Contracts first.** Every track's first PR is its contract with a fake, merged in week 1.
    - **Merging.** Small PRs behind default-off switches; stacks at most two deep; stacked PRs merge with a merge commit, never squash. Each PR gets one AI review (separate context, same model family), with the security lens by path. The repository stays on the agent merge lane; GitHub's merge queue is probably unavailable on a personal account.
    - **Evals.** CI uses recorded model outputs only; no model key in GitHub Actions on a public repository. Live evals run through the staging broker under the staging card. A release publishes only with a passing live-eval digest.
    - **Migrations.** New migration files get UTC timestamp prefixes once the chain tool accepts them. 0001 to 0038 stay as they are.
    - **Staging.** A standing staging card 2 (Claude, E2B staging, development stores, Shopify CLI app-config deploys on the development app, and the email vendor's test sends), proposed before `staging-card-1` ends on 2026-11-18.
    - **Rhythm.** A weekly decision sheet and a weekly staging demo. The week-4 checkpoint (see Consequences).
    - **Other approved items:** fold the P02.A04 participant study into the owner's store's onboarding and the first merchants'; move operational records (cards, live records, staging identifiers) to a private operations repository before production.
    - **Unchanged:** the hardening budget; live-effect records (on a shorter template); the Tier 3 owner sign-off.
11. **Specialists.** Approved 2026-10-23 with every recommended part (Q14).
    - **11a, in launch scope.** When a person asks for help and no installed agent covers the goal, or the person asks for a specialist, the Coordinator drafts a temporary specialist for that task from 1 to 3 eligible first-party skills. Code builds the spec (tools, at most 16 capability ids, data classes, model profile, caps, deadline); the model writes only the brief. A person presses Start on a card whose top lines are written by code; edits only narrow. The specialist does one bounded piece of work and reports back on the task. When installed agents cover the parts, the Coordinator routes instead. One level only; 1 running per task and 2 per workspace; the full credit cap reserved at Start.
    - **11b, authority.** A run-scoped installation (`kind: task_specialist`) of one built-in release, `morrow.specialist`, owned by the starter. The TypeScript kernel and `workspace.task.delegate@1` are unchanged; the spec digest rides on the child task and the run manifest. The SQL layer gets forward migrations on the train's tables: the installation kind; the one-per-store index limited to installed agents; end of life as `uninstalled`; a generalised scope check; a new identity-owner grant issuer whose allowlist is the Specialist ceiling. Start uses a server-built document bound to the actor and session, valid for 5 minutes, single use, rebuilt from live grants, scopes and rules; it locks the parent task, reserves the cap, and issues the envelope (depth 1, 1 child), the installation, its grants, the Coordinator's delegate grant, the child task and the hop in one transaction. For run-scoped installations the Start replaces the stage-and-activate path of `agents.installation.activate` with no second reviewer: the release and its ceiling are fixed and reviewed at release, the installation lasts 24 hours or less, it has no triggers, schedule or mandate, every external effect still needs a digest-bound approval at the gateway, and the starter is the Owner in person. Installed agents keep stage-and-activate.
    - **11c, who starts.** The Owner only at launch (store grants belong to the founding principal, ADR-0022 item 3 as clarified on 2026-10-21); Members after launch; a workspace off switch.
    - **11d, skills.** First-party files (`skills/<id>/SKILL.md` plus a closed `skill.json`) inside agent packages and the specialist release, pinned by each release's digest under the existing release gate. 12 job skills at launch. No skill registry and no skill tools at launch. A skill never grants a tool or a capability. Merchant-written skills come later.
    - **11e, data.** No customer data, no support tools and no Support notebook for specialists. Every read is filtered by the spec's data classes and the starter's read tags together.
    - **One clock.** Envelope, hop and grants last 24 hours from Start. The run lasts 1 hour by default and 8 at most, checked on every tool call. A specialist's proposals expire at the earlier of their ADR-0011 life and the envelope's end; "Run again" drafts them again, never revives them.
    - **Rules and model.** Workspace-level rules bind specialists; specialists default to Ask; a Never on any agent for a class binds them too. Code sets the model profile from the workspace's specialist profile, which the Owner chooses; the person may only lower it.
    - **Reports** are data, never instructions. The Coordinator never reads them at launch, and no spec is drafted in a turn that holds one. Code builds the parent-thread card from typed fields.
    - **Switch and slip rules.** The specialist switch stays off until the deletion paths (run-scoped principals included) and the gateway, reservations and stops exist. Specialists are cut with Marketing if the week-4 checkpoint is missed, and move to the first fast follow if the specialist authority packet is not merged by week 5 (2026-12-04).
    - **11f, after launch:** "Keep this specialist", Member starts, auto-start, proactive or scheduled specialists, more than 1 per task, deeper delegation, merchant-written skills.
    - **11g, not taken:** launching Marketing as skills only. Marketing stays as decision 1 has it and remains the first cut.

### What stays

- **From ADR-0021:** item 2, the production-grade architecture (Worker boundaries; Neon with FORCE RLS and restricted roles; versioned contracts and generated validators; one gateway; digest-bound approvals; the credit ledger; reconcile-before-retry); item 3, the security invariants unchanged; item 5, the lighter process, as decision 10 refines it; item 4's last sentence (the 18 packages, 80 parent tasks and 73 acceptance IDs are not the launch gate); its Consequences on the trimmed P04.T01i PR-B: card effect E11 stays suspended, and the rollback half of AC05, the hosted kill-race drill (AC14's hosted part), the keyring, rotation and rollback drills (AC15 to AC17) and the p95 report (AC19) stay past launch.
- **From ADR-0022:** decision items 1 and 2 (the listings capabilities and the contract additions, the store `ResourceRef` and `StopRecord@1` among them); item 3, except the Coordinator in code (the store resource, the templates, installation grants and agent records); items 6 to 9 (the connector hostname, broker trust model v1, the executor logins, leases for background work); item 10's provider-neutral port, its no-fallback rule and Claude as the model provider; item 11's per-run and per-day USD caps, as a concept with new values; item 15 (the stops); item 16's versioned model catalogue; summary item 14 (one "Approve and apply" button for a solo owner, still two server commands).
- **From the owner's decisions of 2026-10-22 (Q1):** decisions 2 to 5, 7 to 9 and 11 to 14. "Disconnect store", the stale-run sweep, the removed-model (404) alert, the maintenance sweep and the 48-hour fallback are approved and still to be built; they go on the tracks. Decision 1 (CI on the owner's Mac) was overtaken when the owner made the repository public (Q7, Q9); CI runs on GitHub-hosted runners. Decision 6 is replaced by decision 5, and decision 10 by decision 2.
- **The merge train** landed as built, with a merge commit per PR (#37, #39 to #44). Until a companion record replaces an item, the code on `main` keeps following the ADR-0022 item it was built under, on development stores and staging only.

### What is dropped

- The invite-only beta, its M1 to M6 sequence, and the owner's live store as the first test store.
- A private app per merchant; non-expiring tokens; workspace-first linking as the only path (install now starts on Shopify).
- Stripe as a launch route. Its code stays switched off rather than removed (decision 5).
- One credit per drafted product; US$49 for 300 credits.
- Members choosing a model per run (each agent gets a profile at install).
- Supplier email sending; the R2 agent drive; ShopifyQL at launch; the Coordinator's pulse (the Analyst owns it).
- The beta framing of the uncommitted M4, M6 and M7 drafts and of the earlier live-store draft. Their designs are reused.
- New packets and acceptance tables for launch work outside the security-heavy list.

### Companion records before dependent code

Each companion is material under ADR-0002 and gets its own short ADR, at most two pages, put to the owner on the weekly decision sheet. This record authorises none of the code that depends on them. ADR-0024 to ADR-0031 were accepted on 2026-10-23 (OD-2026-10-23-7), from the first sheet (`docs/decisions/decision-sheet-2026-10-26.md`); the production custody and live-store records come on later sheets.

| Companion | Decides | Material because |
| --- | --- | --- |
| [Proactive authority](ADR-0024-proactive-authority.md) (ADR-0024, accepted 2026-10-23) | Mandates (tables, 90-day expiry, renew, revoke, notices, hand-over); the installation as the requester of a proactive run; the editor as a proposal's author; one typed confirmation per solo batch; the 4-hour "approval waiting" email; expired drafts drafted again (amends ADR-0011 Q1) | Authority |
| [Shopify public app](ADR-0025-shopify-public-app.md) (ADR-0025, accepted 2026-10-23) | Distribution; the embedded home and session-token identity with its CSP; expiring-token custody; required and optional scopes; Level 1 and Level 2 requests (amends ADR-0022 decision items 4, 5 and 14) | Security, credential custody, public contracts, merchant data |
| [Billing and price](ADR-0026-billing-and-price.md) (ADR-0026, accepted 2026-10-23) | Shopify App Pricing with Morrow-enforced caps (the Billing API only if Shopify agrees); credits only after a confirmed usage record; the rate card; the plan price; the Stripe route kept off (amends ADR-0022 decision items 11 and 12, refines ADR-0015) | Money |
| [Agent loop and model](ADR-0027-agent-loop-and-model.md) (ADR-0027, accepted 2026-10-23) | The multi-turn loop with tool use (changes `ModelCall@1`); per-agent model profiles; the model-based Coordinator with one level of specialists; SpecialistSpec@1, child runs and the workspace's specialist model profile (amends the Coordinator bullet of ADR-0022 decision item 3, deterministic code and one hop, and decision items 10 and 16) | Public contracts |
| [Specialist authority](ADR-0028-specialist-authority.md) (ADR-0028, accepted 2026-10-23) | The run-scoped installation kind; the Start document and transaction; Start replacing stage-and-activate for run-scoped installations; the SQL grant issuer for the Specialist ceiling; the one 24-hour clock; workspace-level rules binding specialists; the read filters | Authority, spend, public contracts |
| [Runtime and E2B](ADR-0029-runtime-and-e2b.md) (ADR-0029, accepted 2026-10-23) | Per-run sandboxes; rules in code; uploads; the lasting workspace as the next step; E2B's written answers | Provider, security, retention |
| [Email](ADR-0030-email.md) (ADR-0030, accepted 2026-10-23) | Inbound by forwarding; the outbound vendor (Resend), idempotency and status; support replies only | Provider, external messages |
| [Data](ADR-0031-data-retention-visibility-regions.md) (ADR-0031, accepted 2026-10-23) | Retention of the new classes (90 days), per-viewer visibility, data regions (amends ADR-0022 decision item 13) | Retention, merchant data |
| Production custody | ADR-0007 item 9 | Deployment and credential custody |
| Live store after approval | The owner's store as the first real install | Real merchant data |

### Security invariants that do not change

Each keeps its owning tests.
- Tenant data is isolated with FORCE RLS and restricted roles. Client-supplied tenant or workspace identifiers are never authority.
- An agent's effective authority is the intersection of the requester's grants, the installation's grants, the delegation envelope, connector scopes, live policy and the installation owner's current authority. Making the installation the requester of a proactive run does not widen it, because the installation owner's current authority stays in the intersection. A specialist's authority is the same intersection, under the Specialist ceiling.
- Approvals are bound to the exact proposal's digest. Any edit voids them. The gateway re-checks authority before execution. Batch approval is N digests. The specialist Start is digest-bound too.
- Permission and budget checks happen in code, outside prompts.
- Unknown provider or commit outcomes are reconciled before any retry and never promoted to success. This now also covers token refresh, sandboxes, email sends and billing usage records.
- Raw provider, merchant and model credentials are readable only by the broker Worker. Never in the repository, chat, logs, GitHub Actions or the VM.
- Default entry denies. Real routes fail closed without qualified configuration.
- Kill switches are `human_only` and need no second approver. Agents may only propose them; specialists cannot.
- No agent-initiated external effect before the gateway, budget reservations and stop controls exist.
- No real merchant data of a class before its deletion path exists. Never the owner's live shop for development.
- Applied migrations are immutable.
- Production, real merchant or customer data, customer messages, money, publication and App Review submissions need per-action approval.

## Consequences

- **CLAUDE.md** changes three settled-constraint lines with this record: the MVP constraint, the standalone-and-embedded line, and a billing line. Session step 1 changes when the graph command merges; it merged in PR #46, and the owner approved the step on 2026-10-23 (OD-2026-10-23-7, item 35). Its security invariants do not change.
- **CLAUDE.md lines known to be stale.** Decision 10 (Q12) and option A (Q14) approved only the CLAUDE.md edits above, so three more lines needed new wording; the owner approved it with this record ("approve ADR-0023 and the CLAUDE.md lines", 2026-10-23):
  - the intro's "one standalone web workspace and a thin Shopify connector" leaves out the minimal embedded home (decision 2);
  - session step 3's "(ADR-0021, MVP fast track)": the launch plan is this record with `docs/plan/mvp.md`. Proposed: "(ADR-0023, which replaced ADR-0021's listings beta)";
  - the Delivery flow's "one feature-sized PR per brief or packet": decision 10 sets one brief per track and small PRs behind default-off switches, stacks at most two deep, stacked PRs merged with a merge commit. Proposed: that rule, keeping "each PR changes observable behaviour or retires a named risk", with a change behind a default-off switch counting as observable.
- **`docs/plan/mvp.md`** is rewritten as the launch plan: scope, agents and specialists, tracks, gates, dates and cut rules. `build-plan.md` keeps its text and gains launch-order notes pointing here.
- **Planning dates,** from week 0 on Monday 2026-10-26:
  - week-4 checkpoint (G11) by Wednesday 2026-11-25: one agent, one proposal and one gateway apply on a development store, shown in a demo. If missed, Marketing, the computer forecast and specialists are cut at once;
  - production custody ADR approved, and the specialist authority packet merged (G18), by Friday 2026-12-04;
  - production up by 2027-01-01;
  - App Review submission 2027-01-04 to 2027-01-08;
  - public launch (unlisted link, paid) planned for Monday 2027-03-01, in a range from mid-February (one clean review) to April 2027 (several rounds).
- **Serial gates stay real:** the owner's decisions, the Partner account and development stores, E2B's written answers, Shopify Partner support's answers, Shopify's review (no published timeframe), the owner's legal steps, and per-action production approvals during the holiday weeks.
- **New data classes** reach Morrow: order aggregates, customer mail and names, uploads, notebooks, run turns, sandbox files, specialist specs, Start documents, and retired run-scoped principals, installations and grants. Each needs its deletion path first. The privacy policy names the data regions.
- **The merge lane, not coding, sets the pace** (Q5): about four to six merges a day, which is why PRs stay small and stacks stay at most two deep.
- **Specialists** add about 13 to 18 agent-days, about 6 PRs and one security packet (estimates, not measured), on critical-path tracks. The track for the agent platform gets a third agent from week 2 to week 5. The planning date holds by the slip rules, not by spare capacity.
- **Billing review risk:** App Review may pause the app under 1.2.1 if Stripe is reachable from a Shopify install, prices differ from the website, or copy implies outside billing. The embedded home and the plan page never link to Stripe. If App Pricing cannot express credits, Morrow asks for the Billing API or an exemption.
- **Risks named for the graph:** App Review rounds; Level 2 refused; the holiday weeks; E2B's answers late or negative; the merge lane; specialist authority work crowding the agent platform track; an objection to the embedded home under 2.2.2.

## Alternatives considered

- **Keep the invite-only beta.** Rejected by the owner (Q11), and blocked by Shopify's rules on custom apps and billing.
- **One custom app per merchant with Stripe.** Breaks the Partner Program Agreement at the second merchant.
- **Build the whole long-term plan before launch.** Too slow; the owner asked for lean.
- **The whole workspace embedded in the admin** (decision 2 as first approved). Meets requirement 2.2 most directly, but duplicates the standalone product. Option A's embedded home was preferred; full embedding stays the fallback if App Review objects.
- **Embedded only.** Loses the standalone workspace the product is built around.
- **A lasting computer and browser for each agent at launch** (as in Grok Bot and Dots). Paused state needs a proven deletion path, untrusted content builds up across runs, and site sign-ins can never go into the VM. It is the first post-launch runtime step; decision 6 declined the pull-forward.
- **A custom app for the owner's store before approval.** Adds a second app record and a live-store ADR before launch, for about 1 to 2 weeks of work.
- **Billing option B, Shopify only with the Stripe code deleted** (decision 5 as first approved). Gives up ADR-0015's split for no saving now.
- **Billing option C, both routes live at launch.** The most work: the Stripe India invitation, tax filing as the seller, refunds and disputes, and more review risk.
- **Billing option D, a free app with everyone on Stripe** (Q13). Needs a written exemption Shopify is unlikely to give.
- **No specialists at launch.** Simpler, but drops the owner's idea of "one main agent and then other sub agetns" (Q12). It stays the fallback if a slip rule fires.
- **A standing specialist principal per workspace.** A new authority shape that shares grants across runs and needs kernel edits. Rejected for run-scoped installations.
- **Auto-started specialists.** Every run spends credits; a person starts every one at launch.
- **A skill registry with search and skill tools at launch.** Not needed for 12 skills. Later, for a large library.

## Approval

The owner's statements in chat, verbatim. Dates are IST: Q1 to Q11 on 2026-10-22, and Q12 to Q14 after midnight, on 2026-10-23.

- **Q1, 2026-10-22,** answering the morning report's decisions: "yes to all recommended, for CI lets use our mac". This approved the report's decisions 2 to 14 and chose CI on the owner's Mac (ADR-0014, 2026-10-22 amendment).
- **Q2, 2026-10-22:** "lets make sure we do have agent runtime in our mvp".
- **Q3, 2026-10-22:** "okay go with e2b".
- **Q4, 2026-10-22,** correcting an earlier selection: "no sorry i selected the wrong version, i do want the e2b in our mvp".
- **Q5, 2026-10-22:** "we don't need to push the release as we have all the agents at our disposle as we are using opus ultracode we just can run the work in parallel it will take the same amount of time".
- **Q6, 2026-10-22,** on the self-hosted runner's residual risk (a) and the old E2B key: "for the mac ci lets run it as the third party apps doesn't matter as we are not executing anything elsewhere, delted the e2b key".
- **Q7, 2026-10-22:** "okay then i think its better that we make the repo public and use github runners".
- **Q8, 2026-10-22,** on the pre-publication sweep's findings: "its fine not a blocker, anyhing else that is sensitive?".
- **Q9, 2026-10-22:** "no need for new sweep i am going to make the repo public now".
- **Q10, 2026-10-22,** the request for this re-analysis and for the project graph (quoted in full under Context).
- **Q11, 2026-10-22,** the direction:

  > okay then drop this beta launch, we are going to launch mvp but with full fledged feature list that makes the Morrow a good and lean ai worspace for shop owners to run there ecommerce business with humans and ai agents together.

- **Q12, 2026-10-23,** after reading decisions 1 to 10 and the list of earlier approvals they replace:

  > yes to all recommended, send the e2b message and also did we inlcude the point that its multi agent system with one main agent and then other sub agetns which can be started by user as required like suppose user asked for help for a certain task then we create a proper subgent with relevenat skill for the task which will handle that goal? i remember that i talked about this to codex when i started this project before migrating to you claude

- **Q13, 2026-10-23:** "okay now why we migrating away from stripe and going through shopify app store pruchase why not we make the shopify plugin free and user pay on our website for the plan".
- **Q14, 2026-10-23,** after reading decision 11 (specialists, parts 11a to 11g, recommended: yes to 11a to 11e, 11f after launch, 11g no) and the billing comparison (options A to D, A recommended):

  > yes to both, go with option A and specialists

What these approve:
- **Q11** is the direction: drop the beta; launch a lean, full-featured MVP.
- **Q12** approves decisions 1 to 10, each with its recommended option, and the replacement of the earlier approvals listed in the working paper the owner read, which this record restates under "What stays" and "What is dropped". "send the e2b message": the questions were sent to E2B support right after Q12, at about 18:41Z on 2026-10-22, 00:11 IST on 2026-10-23 (`docs/evidence/live/2026-10-22-e2b-support-questions.md`). The question about sub-agents is recorded as the owner's addition to decision 1.
- **Q14** approves decision 11 with every recommended part, and billing option A: decision 5 becomes Shopify App Pricing with Morrow-enforced caps, with M5's Stripe code kept off and ADR-0015's split retained; decision 2's embedded part becomes the minimal embedded home; and CLAUDE.md keeps the standalone workspace as the product, allows the minimal embedded home and adds the billing split.
- **Q2 to Q4** chose the runtime and its provider, which decision 6 shapes. **Q5** keeps the planning date and relies on parallel tracks, which the merge lane then limits. **Q1** carries the 2026-10-22 decisions listed under "What stays". **Q6 to Q9** are recorded in `docs/evidence/live/2026-10-22-github-public-and-ci-runner.md` and ADR-0014 item 8.

Scope of the approval:
- **Decided by the answers:** the direction (Q11); decisions 1 to 10 with their recommended options, the replacements of earlier approvals and the CLAUDE.md edits that decision 10 names (Q12); decision 11 with every recommended part, and billing option A with the CLAUDE.md edits it names (Q14).
- **Written from them:** this record's wording, including the decision bullets drawn from the working papers, "What stays" and "What is dropped", the companion-record table, the planning dates and the exact CLAUDE.md wording. These restate or apply the answers; where they differ, the answers govern.
- **Accepted as written, 2026-10-23, in chat.** Asked "Approve ADR-0023 as written?" together with the proposed wording of the three stale CLAUDE.md lines named under Consequences, the owner answered, verbatim: "approve ADR-0023 and the CLAUDE.md lines". The three lines are updated with this record: the intro names the minimal embedded home, session step 3 points to this record, and the Delivery flow states the small-PR rule.

What this record does not approve: the code that depends on a companion record, which waits for that record; the first use of any provider or production effect, which keeps its per-action approval or card; and the owner's store as an install, which waits for App Review approval and the live-store ADR.

## Amendments

### 2026-10-23: the companion records' answers (OD-2026-10-23-7)

The owner's answer to the 2026-10-26 decision sheet (OD-2026-10-23-7, quoted in the Approval sections of ADR-0024 to ADR-0031) changes these lines of this record through three companion records; the text above is kept as approved.

- **Decision 6, runtime** (ADR-0029 owner questions 2 and 3): "Pro at launch" becomes Pro in a separate production project, bought at production bring-up, W7 to W9. E2B's written answers block adapter code only until 2026-11-20; if they have not come by then, T10 starts the adapter with conservative defaults, every failure after the send mark unknown, and proves the testable answers in qualification.
- **Decision 7** (ADR-0027 item 12): each agent's profile is set at install and may be changed after it, by the Owner, or by an Admin for an installed agent. By default the Coordinator runs Opus 5.5 at high effort, specialists Opus 5.5 at medium and the five installed agents Sonnet 5.5 at low.
- **Decision 11, "Rules and model"** (ADR-0027 item 12): the Owner may pick any offered model and effort on a specialist's Start card; a starter without `governance.model_default.revise` (Members, after launch) may still only lower it.
- **Decision 11b's last sentence and the ADR-0005 entry under "Does not change"** (ADR-0024 owner question 1, answered (b)): installed agents keep stage-and-activate, but in a team the Owner installs an agent and issues or renews its mandate with no second reviewer while no other member holds the mandate's store grants. This amends ADR-0005 item 3; kill switches stay `human_only`.

Members choosing a model per run stays dropped.

### 2026-10-25: one agent kind in place of specialists (ADR-0037)

The owner's decisions of 2026-10-25 (OD-2026-10-25-3, and OD-2026-10-25-4 for the values, recorded in ADR-0037) change these lines; the text above is kept as approved.

- **Decision 1.** The Coordinator line's first two sentences become: "Morrow answers from knowledge, orchestrates teammates for Asks and @mentions in any way the work needs (calling them as tools for structured results, in sequence or in parallel, or, outside an Ask, handing work to them), asks clarifying questions and ranks suggestions. It creates only tasks, questions, messages, plan cards and agent cards; a plan card or agent card creates nothing until a person starts or approves it." The rest of the bullet stays: Morrow is separate from the optional Chief of Staff and CMO, and agent titles and delegation never confer authority. The owner's addition becomes one level of teammates under Morrow: Morrow may propose a new teammate, a person approves its exact card, and teammates cannot create, call or hand off to agents. "Installable agents" gains a second origin: agents Morrow creates from the fixed tool catalogue, which are installations like the premade ones.
- **Decision 11.** Its specialist parts (11a to 11c, 11e, "One clock", "Rules and model", "Reports", "Switch and slip rules" and 11f) are superseded by ADR-0037 items 3 to 9; item 9 carries the slip rule (agent cards move to the first fast follow if G11 is missed or their authority packet is not merged by G18's date, 2026-12-04), so the planning date still holds by the slip rules. 11d stays, except that a workspace-created agent carries instruction and skill text Morrow writes for it, shown in full on its card and bound by its digest; there is still no skill registry and no skill tool.
