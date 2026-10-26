# Morrow production v1: build order

- Record: the owner-facing order of v1's PRs 1 to 26 under [ADR-0035](../decisions/adr/ADR-0035-build-v1-live.md) (build v1 live, accepted 2026-10-23). It runs side by side with the tracks of [mvp.md](mvp.md), which stay the plan from v1 to the public launch.
- Written 2026-10-23 from `main` at `86cd845`, for the owner; added to the repository on 2026-10-24 with its words unchanged below this header and the progress table.
- Changed 2026-10-25 for [ADR-0037](../decisions/adr/ADR-0037-main-agent-and-scoped-subagents.md) (Morrow as the main agent with scoped teammates; OD-2026-10-25-3 and OD-2026-10-25-4) and ADR-0039 (credits are the only spend limit, pull request 75), without changing either record: PR 26 ("Specialists") is replaced by ADR-0037's follow-up PRs ([adr-0037-implementation.md](adr-0037-implementation.md)); PR 12's "one active agent, once" becomes Morrow orchestrating teammates in any way at depth 1; PR 11's and PR 21's money caps become credit holds; PRs 2, 7, 10 and 18, already merged, gain notes where the later records change what they built.
- Changed 2026-10-26 for [ADR-0041](../decisions/adr/ADR-0041-harness-foundations.md) (harness foundations) and [ADR-0040](../decisions/adr/ADR-0040-messaging-with-agents.md) (messaging with agents), both Accepted (OD-2026-10-26-7), and the owner's rule that the foundation is production grade, never an MVP (OD-2026-10-26-6), without changing either record: PR 11 becomes the harness foundation; PR 12 grows from M to L and splits into 12a (the backend) and 12b (the screens); PRs 15, 16, 20 and 21 gain the harness and messaging changes; the model list is Opus 5.5 only; each points to its rows in [harness-foundations-implementation.md](harness-foundations-implementation.md). Also that day the owner chose to build the P09.T05 customer-data deletion path first, with the new Morrow conversation off until it exists, and said that ADR 0042's COD Confirmation agent is an installable agent that is not built now.
- Changed again on 2026-10-26 for OD-2026-10-26-12 (credits are the only budget, pull request 89; the 2026-10-26 Amendments of ADR-0039, ADR-0040 and ADR-0041), without changing any record: PR 11 has no cost check-in and no pause on Morrow's provider spend, only an alert to you at 80% of your Anthropic monthly limit; PRs 12 and 21 have no per-person limit on requests or standing requests.
- Graph: each PR is a milestone node, `V1-PR01` to `V1-PR26` (`docs/graph/milestones/`), part of its tracks, delivering its features, waiting on its gates; a merged pull request whose title starts "v1 PR <n>:" implements it.

## Progress

At `main` `14644dec`, 2026-10-26. ADR-0039's first code PR (#83: Listings' catalogue version 4, Opus 5.5 at medium and high, with no run or daily cap; migration 0056) and #89 (credits are the only budget, OD-2026-10-26-12; documents only) merged that day too; neither is one of the PRs below.

| State | PRs |
| --- | --- |
| Merged | 1 (#50; its decision record ADR-0035 in #48), 2 (#53, "Disconnect store"; the Claude switch on with the owner's key in #73), 3 (#54), 4 (#67), 5 (#66), 6 (#80), 7 (#51), 8 (#63, switch off), 10 (#52), 14 (#55), 15 (#65), 16 (#56), 17 (#49, ADR-0033 and ADR-0034), 18 (#58), 19 (#57), 20 (#68) |
| Building now | 11 (#64, held and rebuilt to ADR-0041 as rows H4 and H7a to H8 of the harness plan (on PR #64), after the contracts of H5 (PR #79) and H6) |
| Not started | 9, 12, 13, 21 to 25 |
| Reshaped (2026-10-26) | 11, 12, 15, 16, 20 and 21, by ADR-0040 and ADR-0041 ([harness-foundations-implementation.md](harness-foundations-implementation.md)); merged PRs keep what they built and gain the changes as new rows |
| Replaced (2026-10-25) | 26, by ADR-0037's follow-up PRs 1 to 10 ([adr-0037-implementation.md](adr-0037-implementation.md)), of which 2, 4, 5, 9 and 10 continue as harness plan rows since 2026-10-26 |

---

Written 2026-10-23 from `main` at `86cd845`. It follows the owner's instruction of 2026-10-23 (OD-2026-10-23-9): build live, keep one environment, use the owner's own Shopify store and Anthropic key, and set up E2B now.

## Where we are today

Built, deployed, and switched off wherever it could cost money or touch a store:
- Sign-in and workspaces (WorkOS). Nobody has signed in to the deployed copy yet.
- The Shopify connector can install, link, read products, handle uninstall and answer Shopify's privacy requests. It refuses any store that is not a Shopify development store, and its web address is not switched on.
- The Listings agent can be turned on per store. It has "Stop AI work", credits, the model list, and drafting with Claude one product at a time. The Claude switch is off and no key is placed.
- Billing on Stripe exists but is switched off. A 300-credit grant can put one workspace on the plan without Stripe.
- Exact-change approval records exist in the database.

Not built yet:
- The apply step ("the gateway"): approve, write to Shopify once, read the product back, record the result, undo.
- The review screen (before and after) and the approve and apply buttons.
- "Disconnect store". We agreed it lands before the first Claude call.
- E2B. Only old test scripts exist.
- The agent loop with tools, Morrow as a model (the Coordinator), model and effort settings per agent, proactive work, shop knowledge, projects, the Sunrise look and the other five agents.

## How we work from now on

PR 1 records these rules in a one-page decision. Nothing below starts until you say yes to it.
- **One environment.** The copy already running on Cloudflare and Neon becomes production v1. It is called "staging" inside the code. We keep that name for now because renaming changes nothing you see.
- **Your live store** connects through a private Shopify app made for your store only. No development stores.
- **Product data first:** titles, descriptions, SEO and tags. Customer data comes only after Morrow can delete it on request. That rule stays. Other new kinds of data (order totals, for example) get their delete step in the PR that adds them where possible, and always before outside customers.
  *2026-10-26: you chose to build that deletion path for customer data (P09.T05) first, as part of the foundation. The new Morrow conversation (ADR-0040) stays off until it exists.*
- **One standing yes** from you replaces asking each time for deploys, database updates, Claude calls and E2B runs within the spend caps, and the usual 300 test credits a month for your own workspace.
- **Still a yes every time:**
  - every change to your store, which you give inside Morrow on the exact change, because the product works that way;
  - any message to a customer;
  - ad spend, purchases and plan changes;
  - raising any spending limit;
  - App Store submission;
  - deleting data;
  - any store other than yours.
- **Claude builds and tests against fakes.** Claude never changes your store outside Morrow, never copies customer data into a chat, and keeps your store's name and data out of the public repository.
- **Every PR still gets the automatic checks and one AI review** before merge. They take hours, not days, and they keep a bad change off your real store.
- **E2B starts now with careful defaults,** instead of waiting until 2026-11-20 for E2B's written answers.
- **Dropped:** staging card 2, development stores and the separate test-store measurements (your first real runs are measured instead).
- **Until you want outside customers:**
  - the questions to Shopify Partner support;
  - the public app and App Review;
  - Shopify billing and a separate production copy.

## How to read the list

- Size: S is under a day, M is 1 to 3 days, L is 3 to 6 days of building before review.
- "Needs from you" lists only what you do yourself. "Nothing" means nothing.
- "Safety tests" are the checks each PR must add or rerun. The five rules behind them are at the end of this file.
- Lanes run side by side. Merges happen one at a time, about four to six a day.

| Lane | PRs | Starts |
| --- | --- | --- |
| A. Store, Listings, apply | 1 to 6 | now |
| B. E2B computer | 7 to 9 | now |
| C. Agent platform | 10 to 13 | now with 10, then in order; since 2026-10-26, 11 and 12 follow the harness plan |
| D. Sunrise screens | 14 to 16 | now with 14 |
| E. Projects | 17 to 19 | now with 17 (decision only) |
| F. Knowledge and proactive work | 20, 21 | after 10 and 11 |
| G. The other agents | 22 to 25, and ADR-0037's follow-up PRs in place of 26 | after 5, 11, 13 and 21; the follow-up PRs as their plan says |

## Milestone 1: "Listings suggests changes to my real products, and I apply one I approve" (PRs 1, 2, 3)

Target: about a week and a half, early November, if reviews and your steps are quick. PRs 2 and 3 are built at the same time as PR 1, and they go live in order. Halfway point, about a week in: PRs 1 and 2 live, and you see Claude's drafts for your real products.

### PR 1. Connect your live store (milestone 1)
- **Delivers:**
  - **The decision record:** ADR-0035, "Build v1 live". It changes the rules it lists, including the CLAUDE.md lines about your live store and per-action approval. ADR-0033 and ADR-0034 stay reserved for the project flow. With it come the standing approval, which replaces staging card 1 and its 2026-11-18 end date, and the card file the tools read (this must land before 2026-11-18).
  - **One live store allowed:** the connector admits one store that is not a development store, only the store whose domain was named when your app was registered, and only for that app. Any other live store still gets nothing.
  - **The connector's web address** switched on, so that Shopify can reach Morrow. The emergency kill switch takes it offline together with the main address.
  - **One registration command:** it stores your app's secret, sealed, and registers the app, with a short record.
  - **Your first sign-in:** if it fails on the deployed copy, this PR fixes it.
- **Needs from you** (about 30 minutes, in this order; the full clicks are in your setup steps):
  1. Say yes to the decision record in chat.
  2. Sign in to Morrow once with your existing login and create your workspace.
  3. In Shopify's Dev Dashboard, create the app with custom distribution for your store's domain. Run the one deploy command with the file Claude gives you, and copy the install link. Then seal the app's client secret with `npm run vault -- seal-app-secret` in your own Terminal (not through Claude's `!`), never in chat.
  4. In Morrow, open the install link and approve in Shopify. Then press "Link store" and "Enable Listings agent".
  Claude adds the 300 test credits to your workspace before the store is linked; the decision record covers that.
- **Size:** M.
- **Safety tests:**
  - A different live store that uses your install link stores nothing. A second "live" app is refused. Every other app still accepts development stores only.
  - The kill switch takes both public addresses offline. The deploy check still fails if any other Morrow Worker is on a public address.
  - A bad signature, a replayed or expired install, or an unknown app stores nothing (the existing install cases, rerun with the live flag).
  - Only the workspace owner links, and only into your workspace with credits. Another workspace sees nothing of the store (the tenant cases, rerun).
  - The app secret and the store token exist only inside the broker, encrypted. The command prints only a fingerprint and refuses a production database.
  - Uninstall and Shopify's deletion requests still work for the live store (the privacy cases, rerun).
  - Without its settings the connector stays closed, and the per-address limits stay pinned.
- **Runs in parallel with:** 2, 3, 7, 10, 14 and 17, which are built at the same time.

### PR 2. Listings drafts changes for your real products (milestone 1)
- **Delivers:**
  - **"Disconnect store" in Morrow,** for you only. It stops all AI work on the store, ends running jobs at their next step and destroys the store token.
  - **The Claude switch turned on,** in the same PR as "Disconnect store", never before it, with the command that places your key in the broker.
  - **Measured first runs:** time and tokens are recorded, so the model limits are checked against real numbers.
  - Products are picked by their Shopify product numbers on Ask, as today. The product picker comes in PR 4.
- **Needs from you:** in the Anthropic Console, a workspace for Morrow with a monthly spend limit (we suggest US$50 to start) and a key inside it. Save the key with `morrow_put` in your own Terminal (setup steps, Part 1). Then Claude places it in the broker with one command that reads the file and never prints it. Tell Claude the limit, never the key.
- **Size:** M.
- **Safety tests:**
  - Only a person who holds the disconnect right can disconnect, and agents cannot. After a disconnect nothing reads the store and the token is gone (the stop and kill-switch cases).
  - Existing links gain the disconnect right through a forward database change, and nothing else.
  - The switch is all on or all off across the Workers. The key is only a broker secret (the config and boundary checks).
  - Every run reserves its credits first, from the workspace's wallet, and stays within 25 products (credits are the only spend limit since ADR-0039, which removed the US$7 per run and US$25 a day). "Stop AI work" ends a run before its next product.
  - Product text cannot change the model, the fields or the product (the existing injection cases).
- **Runs in parallel with:** PR 1 while it is built. It goes live after PR 1.

### PR 3. Review, approve and apply to Shopify (milestone 1)
- **Delivers:**
  - **A review screen** for each product: before and after for each field, tag changes marked, new links, emails or phone numbers flagged, and the description shown safely.
  - **Approve all, approve some, or reject.** An approval covers that exact change, and an edit makes a new one.
  - **"Apply":**
    - Morrow re-checks the permission, the stops and the credits, then re-reads the product.
    - It writes the product to Shopify once, reads it back, and shows the result for each product.
    - If the product changed in Shopify since the draft, Morrow does not write and tells you.
  - **The apply history** on the task.
- **Needs from you:** approve and apply your first change, on a product you don't mind. A draft product is safest.
- **Size:** L. It may land as two stacked PRs: 3a, the apply engine, and 3b, the screens.
- **Safety tests:**
  - An approval that is stale, edited, expired or rejected, or that came from someone who has since lost the right, writes nothing.
  - A double click, two tabs or a retry writes each product once.
  - A stop or a disconnect between approval and write means no write.
  - If the reply is lost after sending, the change is marked "unknown" and settled by reading the product back. It is never sent twice (the send-then-crash cases).
  - Each Shopify answer ends in the right state, with never two writes: success, user errors, throttling, 401, timeout, a 5xx error, an edit made at the same moment, and Shopify reformatting tags or HTML.
  - Only the approved fields are sent. Job records and logs hold ids only.
  - Another workspace's change is "not found" and nothing is written. Every new table is isolated per tenant.
  - The store token never leaves the broker.
- **Runs in parallel with:** PRs 1 and 2. The apply engine is built against fakes from day 1.

## Your steps for milestone 1, in order

1. Say yes to the decision record (PR 1).
2. Create the Anthropic workspace, set the spend limit and save the key (PR 2). You can do this today.
3. Create the Shopify app, deploy it and seal its secret (PR 1, step 3).
4. Sign in to Morrow once and create your workspace.
5. Install the app, link the store and enable Listings.
6. Ask Listings to improve 1 to 3 products, by product number.
7. Review the drafts, approve one, apply it, and check it in your Shopify admin.

## Milestone 2: safe to use every day (PRs 4 to 6)

### PR 4. Undo, history and the product picker
- **Delivers:**
  - **"Undo"** on any applied change, for 90 days. Morrow builds a new change from the values it read before applying, you approve it, and it goes through the same apply step. If the product changed since then, Undo stops and shows why.
  - **"Approve several at once"** with one confirmation (ADR-0024 item 9).
  - **A product picker on Ask:** search for products or pick a collection, instead of typing product numbers. It may ship as its own small PR.
- **Needs from you:** nothing.
- **Size:** M.
- **Safety tests:**
  - The picker reads only your linked store, behind the same permission check. Another workspace gets "not found".
  - An undo is a new exact approval, with no shortcut past the apply step.
  - If the product changed since the apply, nothing is written.
  - A second undo of the same change is refused.
  - After 90 days, or after Shopify asks to delete the shop's data, Undo shows "no longer available".
  - Another workspace's change is "not found".
  - A batch is many exact approvals: one bad item refuses them all.
- **Runs in parallel with:** lanes B to E. It starts after PR 3.

### PR 5. Keep the store connection healthy
- **Delivers:**
  - **Permission changes keep the connection:** a change to the app's Shopify permissions stops only the agents that lack a permission they need, and puts "Reconnect" in your Inbox (ADR-0025 item 10).
  - **Reinstall:** reinstalling the same app works.
  - **The approved clean-up jobs:**
    - leftover tokens are destroyed;
    - missed Shopify messages are retried;
    - if Shopify's deletion request never comes, Morrow deletes the data itself 48 hours after an uninstall;
    - stuck jobs are closed.
- **Needs from you:** nothing. Until this PR lands, don't uninstall the app or change its permissions: today either one ends the app for good, and reconnecting then needs a new app record.
- **Size:** M.
- **Safety tests:**
  - A permission change keeps the token and stops only the agents it affects. Nothing resumes by itself.
  - An uninstall destroys the token.
  - The 48-hour deletion runs once and leaves a record.
  - The clean-up jobs carry ids only and reach no other tenant.
- **Runs in parallel with:** PR 4. It must land before any new Shopify permission (PRs 22 to 25).

### PR 6. Credits for your own workspace
- **Delivers:** today the 300-credit grant lasts 30 days and cannot be renewed. This PR lets Claude renew test credits for your own workspace with one command and a one-line log entry, until Shopify billing exists for customers. No money changes hands; your Anthropic monthly limit stays the real cap.
- **Needs from you:** nothing for the usual 300 credits a month. More than that needs your yes in chat, because it raises a limit.
- **Size:** S.
- **Safety tests:**
  - It works only for your own workspace, the one linked to your store.
  - It writes no payment rows.
  - Credits come only from the recorded grant.
  - It is refused on any other database.
- **Runs in parallel with:** anything. It must land within about four weeks of PR 1.

## E2B computer (PRs 7 to 9; start now)

### PR 7. Computer foundation
- **Delivers:**
  - **One door for every computer job:** the runtime port, with a fake for tests.
  - **A record for each sandbox.**
  - **The on and off switch,** committed off.
  - **Spending caps:** a monthly computer budget below E2B's US$20 limit, and at most 3 sandboxes per workspace. *2026-10-25: ADR-0039's runtime PR removes the monthly budget, so computer time holds credits like any step and E2B's own usage limit is the outside backstop; the sandbox limits stay.*
  - **A credit hold** for computer time.
- **Needs from you:** nothing.
- **Size:** M.
- **Safety tests:**
  - Each sandbox record is isolated per tenant.
  - The "sent" mark is saved before any sandbox is created.
  - An unknown result is never counted as success or blindly retried.
  - "Not found" alone never counts as deleted.
  - The switch is off by default, and the caps are checked in code.
- **Runs in parallel with:** lanes A, C and D.

### PR 8. Connect E2B
- **Delivers:**
  - **E2B calls from the broker only,** as plain web calls: no E2B library, and no redirects followed.
  - **The template recipe** in the repository: Python data libraries, no browser.
  - **Locked-down sandboxes:** internet off, a 15-minute limit, killed when the job ends and on any stop.
  - **A clean-up job** for leftover sandboxes.
- **Needs from you:**
  - In project Morrow-staging, create an E2B API key and save it with `morrow_put` in your own Terminal (setup steps, Part 2). Claude then places it in the broker with the same command as your Anthropic key, which never prints it.
  - Build the template in your own Terminal with your own E2B login, using the exact commands Claude gives you. Claude never builds it.
- **Size:** L.
- **Safety tests:**
  - The key is only a broker secret.
  - Nothing a sandbox receives contains a key, a store address, a customer field or a Morrow link.
  - The sandbox's own access token is kept in the vault and destroyed when the sandbox is killed.
  - Stops kill sandboxes, and clean-up is never blocked.
  - A broken E2B reply sets a hold that only a person can lift.
- **Runs in parallel with:** lanes A, C and D. It starts after PR 7.

### PR 9. Check E2B and switch it on
- **Delivers:**
  - **A recorded check on made-up data:**
    - nothing inside the sandbox can reach the internet;
    - Morrow's code inside cannot read the sandbox token;
    - the time limit kills the sandbox without pausing it.
  - **The switch turned on,** first for made-up data, then for product data.
- **Needs from you:** nothing; Claude sends you the check's result. E2B's data processing terms are needed before outside customers, since your product data holds no customer data.
- **Size:** S.
- **Safety tests:**
  - The three checks above, recorded.
  - Outputs are only PNG, CSV (formulas made harmless) and XLSX (no macros or links), served as downloads.
  - Any change of template, region or E2B code voids the check.
- **Runs in parallel with:** lanes A, C and D. It starts after PR 8. Agents use the computer from PR 13.

## Agent platform (PRs 10 to 13)

### PR 10. Contracts for the agent platform
- **Delivers:**
  - **The formats:** the fixed list of tools, the agent package, the new model call, mandates (an agent's standing permission), specialist cards and Inbox item kinds. *2026-10-25: ADR-0037's contracts PR retires the specialist cards in favour of agent cards and teammate results.*
  - **A fake for each,** so that the screens and the loop can be built against them.
  - It may become two PRs.
- **Needs from you:** nothing.
- **Size:** M (perhaps two PRs).
- **Safety tests:**
  - No tool takes SQL, a web address, a store, a recipient, a credential or a model.
  - Validators are generated ahead of time, never compiled at runtime.
  - The old formats stay unchanged.
- **Runs in parallel with:** everything. It starts now.

### PR 11. The agent loop
*2026-10-26: ADR-0041 makes this PR the harness foundation, built production grade with no shortcuts, as you asked that day. It is now rows H4 and H7a to H8 of [the harness plan](harness-foundations-implementation.md) (on PR #64), after the contracts of H5 (PR #79) and H6, as several PRs.*
- **Delivers:**
  - **One durable job runner for every agent** (AgentRunWorkflow):
    - the model can call Morrow's tools;
    - each tool call is checked and recorded;
    - a job can wait for your answer.
    - **Work is never cut short by a limit.** A job that trips a safety check, needs your answer or runs out of credits pauses, keeps its place and asks you; Continue picks it up (ADR-0041 item 3).
    - **Agents never run out of room.** When a job's working memory fills, older parts are summarised, and the facts that matter (your words, approvals, changes made, ids) are rewritten by code from the records (ADR-0041 items 11 and 13).
  - **Listings moves onto it.**
  - **The model list:** Opus 5.5 only, at medium and high (catalogue version 2, rewritten Opus-only; ADR-0041 item 2). Haiku, Sonnet and low effort are gone, as you decided on 2026-10-26. Listings' own catalogue is already Opus 5.5 only (version 4, merged in #83).
- **Needs from you:** one yes to the catalogue version 2 values (its safety check-in values and prices).
- **Size:** several PRs (harness plan H4 and H7a to H8), the runner's behind the agent-loop switch.
- **Safety tests:**
  - Every tool call re-checks the requester, the agent, the store connection, the rules, the stops and the owner's current rights. It is refused if any one of them fails.
  - Text from products, email or uploads enters only as marked data. It can never choose tools, recipients or limits, and a change built from it needs your approval of the exact change.
  - An unknown model turn is booked at its worst-case cost and sent again at most once; a second unknown pauses the job and retries later (ADR-0041 items 8 and 17).
  - Conversation text lives only in a tenant-isolated table. Job records and logs hold ids only.
  - Each step's credit hold, the safety check-ins and the loop detectors are checked in code, never in the prompt, and the model is never shown a countdown. Credits are the only spend limit: a job holds and draws credits from the workspace's balance as it works and pauses when the balance cannot cover its next step, with no money cap per job or per day (ADR-0039; ADR-0041 item 9). Apart from your balance and an optional per-agent credit limit you may set, which pauses only that agent, no amount of spend pauses a job or makes it check in: there is no cost check-in, and when Morrow's provider spend this month reaches 80% of your Anthropic monthly limit, code alerts you, as Morrow's operator, and nothing pauses; a job waits on that limit only when Anthropic actually refuses a call, until you continue (OD-2026-10-26-12).
  - A summary the model writes can never lose or invent an approval, a change or an id: code renders those from the records, and a summary holding a customer's email address or phone number is refused (ADR-0041 items 13 and 31).
  - The switch stays committed off until all of these pass, with the harness plan's evals.
- **Runs in parallel with:** lanes A, B and D. It starts after PR 10.

### PR 12. Your Morrow conversation ("Ask Morrow"), and effort for each agent
*2026-10-26: ADR-0040 changes how you talk with Morrow. This PR grows from M to L and splits in two: 12a, the backend (harness plan H11a and H11b), and 12b, the screens (H14).*
- **Delivers:**
  - **Morrow, the main agent, runs on a model.** It answers, asks a clarifying question when it needs one, and keeps the conversation while it uses its teammates in any way the work needs (ADR-0037): it can ask several teammates, one after another or at the same time, ask the same one again, and pass what one found to the next; it hands the work over when a teammate must talk with you itself. Teammates never bring in other agents. Asking teammates for answers comes with ADR-0037's follow-up PRs 4 and 5, now harness plan H10 and H11a.
  - **It feels like messaging a team** (ADR-0040): you write at any time and the box never locks; "Seen by Morrow" appears within seconds; Morrow answers, asks one question, or says what it understood and starts the work in the background on a card that shows its progress; the result arrives as one finished message; several requests run at once, with no limit on how many you start, each with its own Stop (OD-2026-10-26-12); a reply to a working request goes into it.
  - **Morrow remembers your conversation:** one continuing memory, private to you, so every request starts from what you have already talked about (ADR-0041 item 5). Teammates are asked only inside a request's own background work, so you can keep writing.
  - **"Thinking effort"** on each agent's page and in Settings: Opus 5.5 at medium or high.
  - **Defaults:** Morrow on Opus 5.5 at high; every teammate, the installed agents and those Morrow creates, on Opus 5.5 at medium (ADR-0036, ADR-0041 item 2). A change applies from the next job.
- **Needs from you:** before 12b merges, look at your Morrow conversation drawn both ways, your own messages on the left and on the right; the right-hand layout stands unless you then say otherwise (ADR-0040 item 11).
- **Size:** L, in two parts: 12a (backend) and 12b (screens).
- **Safety tests:**
  - Morrow's own rights are fixed: no store reads, no change proposals, no computer and no customer data.
  - Only a person starts Morrow. Morrow may call teammates and hand work off as many times as the work needs, in sequence or in parallel, at depth 1: each call or hand-off is one child job under Morrow's permission envelope, checked in code on its own against your rights, the teammate's grants, its owner's current rights, the store connection, the rules and the stops; a teammate never calls, hands off to or creates an agent. A job's calls are bounded by its safety check-ins (it pauses and asks you, never stops early), the workspace's credits and your stop, never by a money cap.
  - Only the person who asked can steer or stop a request. Other people's messages never reach or wake it; they enter later work only as marked data that names its author (ADR-0040 items 7, 8 and 13).
  - A customer's email address, phone number, street address or customer id typed into a message is refused until the customer-data deletion path exists, and the box carries a line asking you not to type customers' names (ADR-0041 item 31).
  - Stop on a request needs no second person, and agents can neither hold nor use it; the workspace stop for the Owner and Admins is lifted only by a reviewed step (ADR-0040 item 10).
  - The browser gets only hints, then pulls what you may see; nothing about another person's private conversation ever reaches you (ADR-0040 items 1 and 15).
  - Only the Owner can change an agent's effort, and Admins only for installed agents; nobody can pick a lower effort or another model.
  - An effort change never changes what an agent may do.
  - Each change is recorded.
- **Runs in parallel with:** lanes D and E. 12a starts after PR 11; 12b is built against fakes now, and its switches go on after 12a and the live channel (harness plan H13).

### PR 13. Computer tools for agents
- **Delivers:**
  - **Analysis in a sandbox:** agents run analysis in E2B and hand back charts, CSV or XLSX files.
  - **Uploads:** CSV and XLSX uploads are opened only inside a sandbox.
- **Needs from you:** nothing.
- **Size:** M.
- **Safety tests:**
  - Only agents whose package needs the computer get it, and the install screen says so.
  - Uploads are at most 10 MB. Morrow's web Workers never parse them or serve them back. They keep the uploader's visibility and are deleted on request.
  - After a crash, a computer step answers "outcome unknown" instead of running again.
- **Runs in parallel with:** lanes D and E. It starts after PRs 9 and 11.

## Sunrise workspace (PRs 14 to 16; start now, on fakes)

### PR 14. The Sunrise look and Home
- **Delivers:**
  - **The Sunrise look:** colours, type and agent characters (ADR-0032), and the app frame.
  - **Home:** the daily pulse, goal progress and "needs you".
- **Needs from you:** a quick look at the screenshots.
- **Size:** M.
- **Safety tests:**
  - The screens decide nothing: the server checks every action.
  - Keyboard and screen-reader checks pass at phone and desktop widths.
- **Runs in parallel with:** everything. It starts now.

### PR 15. Sunrise Inbox and review
- **Delivers:**
  - **One Inbox** for approvals, questions, reconnects and problems.
  - **PR 3's review screen** in the Sunrise look, with batch approval.
  - **The activity log.**
  - *2026-10-26: ADR-0040 and ADR-0041 add, as harness plan row H15: "Needs you" links from request cards and check-ins; a review card that names whose words or notes shaped a suggested change, and the outside text it read; the activity log and daily summary read from the job event log and leave out other people's private conversations.*
- **Needs from you:** nothing.
- **Size:** M.
- **Safety tests:**
  - Product HTML is always shown as text, and previews run in a locked-down frame.
  - The approve buttons send the exact change's fingerprint.
  - Each person sees only the items they may see.
- **Runs in parallel with:** lanes B, C and E. It starts after PRs 3 and 14.

### PR 16. Agent pages, the catalogue and Settings
- **Delivers:**
  - **The agent catalogue and install,** showing the Shopify permissions each agent needs.
  - **A page for each agent,** with its notebook and its model settings.
  - **Settings.**
  - *2026-10-26: the model settings become effort only, Opus 5.5 at medium or high (harness plan H3); Settings gains Memory, for your own private memories, and Notifications (H12b and H16).*
- **Needs from you:** nothing.
- **Size:** M.
- **Safety tests:**
  - Install confirms one document built by the server.
  - Optional permissions are requested, never assumed.
- **Runs in parallel with:** lanes A, B and E. It starts after PRs 12 and 14.

## Projects (PRs 17 to 19)

### PR 17. Project flow decisions (ADR-0033 and ADR-0034)
- **Delivers:** two one-page records for the flow on the design canvas. You ask; Morrow makes a project and checks in; it hands parts to agents; you review; it updates you and wraps up.
- **Needs from you:** read them and say yes.
- **Size:** S (writing only).
- **Safety tests:** none (no code).
- **Runs in parallel with:** everything. It starts now.

### PR 18. Projects behind the scenes
- **Delivers:** projects with goals and tasks, hand-offs to agents, check-ins, updates, a wrap-up, threads and @mentions.
- **Needs from you:** nothing.
- **Size:** L.
- **Safety tests:**
  - Only Morrow hands work to agents, once per job. *2026-10-25: ADR-0037 lifts "once per job" for the later PRs: Morrow may use teammates in any way at depth 1 (its follow-up PRs 4 and 5).*
  - Every store change inside a project still needs your approval of the exact change.
  - Each person sees only what they may see.
  - Every new table is isolated per tenant.
  - Each new kind of data has its deletion path before any real data.
- **Runs in parallel with:** lanes A, B and D. It starts after PRs 11 and 17.

### PR 19. Project screens
- **Delivers:** the canvas screens for asking, the check-in, the hand-off, review, the update, the wrap-up and the hand check.
- **Needs from you:** a quick look.
- **Size:** M to L.
- **Safety tests:** the same screen rules as PR 15.
- **Runs in parallel with:** lanes A, B and G. It starts after PRs 15 and 18.

## Knowledge and proactive work (PRs 20 and 21)

### PR 20. Shop knowledge and notebooks
- **Delivers:**
  - **Pages** for brand voice, policies, product facts, suppliers and decisions, with versions and sources.
  - **Agents propose additions,** and you accept them.
  - **A notebook** for each agent.
  - **Listings writes in your brand voice.**
  - *2026-10-26: ADR-0041 builds on this, as harness plan rows H12a to H12f: notebooks keyed by agent, each lesson marked with who it was learned for and whether outside text shaped it; agents reading their notebooks back, and an upkeep run that tidies them with a diff you can roll back; pages you pin ("Always know this"); your own private memories, saved only when you tap Save; and a search check on your store's data that decides whether embeddings are needed.*
- **Needs from you:** write or approve your brand voice page.
- **Size:** M.
- **Safety tests:**
  - Pages are isolated per workspace.
  - Search covers only what the person asking may see.
  - Page text is treated as data.
  - The deletion path exists before any real content.
- **Runs in parallel with:** lanes A, B, D and E. It starts after PR 10.

### PR 21. Agents that work on their own
- **Delivers:**
  - **A 90-day standing permission** for each agent, which you confirm and can revoke at once.
  - **Schedules** in your timezone.
  - **Triggers** when products change in Shopify.
  - **Listings' weekly quality sweep.**
  - **A daily read-only look** for useful work.
  - **Quiet hours.**
  - **Standing requests** (ADR-0040 item 12; harness plan H17): you ask Morrow to do something on a schedule ("Every Monday, check which best sellers will run out in the next two weeks"), confirm it once, and Morrow posts what it found in your Morrow conversation. Pause or revoke it at any time.
- **Needs from you:** confirm each agent's standing permission, every 90 days, and each standing request you want.
- **Size:** L.
- **Safety tests:**
  - Jobs start only from Morrow's own trigger records, never from text.
  - Each job checks the permission, the stops, quiet hours and the workspace's credits, and runs once per trigger. There is no money cap per agent, per day or on the daily look: each job holds and draws credits as it works, and a trigger the balance cannot cover waits until it can, never dropped (ADR-0039). One look for work per agent a day stays.
  - Only you can revoke, and revoking voids pending approvals.
  - The daily look cannot propose changes or use the computer.
  - A standing request runs under your current rights and is skipped, and you are told, if you lost them; it can read and suggest, never change the store; the workspace stop and "Stop AI work" block it; there is no limit on how many you have, and each firing holds credits and waits while the balance cannot cover it (OD-2026-10-26-12).
  - Nothing reaches your store without your approval. The apply step, the credit holds and the stops are already in place from PRs 2 and 3.
- **Runs in parallel with:** lanes D and E. It starts after PRs 3, 5 and 11.

## The other launch agents (PRs 22 to 25) and new teammates (PR 26, replaced)

Each new Shopify permission needs one "Reconnect" approval in your Shopify admin, which works after PR 5. Order and customer data each need their own deletion path first; the customer-data path (P09.T05) is now built first, as part of the foundation (your choice of 2026-10-26).

COD Confirmation (ADR 0042: calls to cash-on-delivery customers through your own calling service, under a call plan you approve) is an installable agent and is not built now (2026-10-26). It is not one of these PRs. You asked instead that the foundation be ready for agents like it: agents that read your store's live data, orders and customers included once their deletion paths exist, and act on store events and on schedules.

### PR 22. Business Analyst
- **Delivers:**
  - **A daily pulse and a weekly review.**
  - **Watches** on sales, order value, refunds, unfulfilled orders, stock cover and margin.
  - **Investigations** that use the computer.
- **Needs from you:**
  - Approve the new "read orders" permission in Shopify.
  - Fill in Shopify's protected customer data form for the app, at the basic level: no names, emails or addresses.
- **Size:** L.
- **Safety tests:**
  - Order data comes through fixed queries, with no customer name, email, phone or address, and covers 60 days at most.
  - The deletion path for order data lands first, and Shopify's deletion requests cover it.
  - The computer gets only trimmed extracts.
- **Runs in parallel with:** lanes D and E, and PR 24. It starts after PRs 5, 13 and 21.

### PR 23. Inventory and Purchasing
- **Delivers:**
  - **Days of cover,** and alerts for low and dead stock.
  - **Reorder suggestions,** with a purchase-order spreadsheet and a supplier email draft that you send yourself.
- **Needs from you:** approve the "read inventory" and "read locations" permissions.
- **Size:** L.
- **Safety tests:**
  - The same checks as PR 22.
  - Morrow never emails suppliers.
- **Runs in parallel with:** PRs 24 and 25. It starts after PR 22.

### PR 24. Marketing and Promotions
- **Delivers:**
  - **A weekly promotion plan,** with campaign and social copy.
  - **Discount proposals** within a cap, and ending discounts.
- **Needs from you:** approve the "write discounts" permission and set a discount cap.
- **Size:** M to L.
- **Safety tests:**
  - A discount involves money, so you type a short confirmation.
  - Caps are checked in code.
  - Ending a discount goes through the same apply step, with read-back.
- **Runs in parallel with:** PRs 22, 23 and 25. It starts after PRs 4 and 21.

### PR 25. Customer Support
- **Delivers:**
  - **Email in:** support email forwarded to Morrow.
  - **Drafted replies** to "where is my order", returns and product questions.
  - **Every send approved,** from the address you pick. Your Morrow address is the default.
  - **Refunds and cancellations** handed to you.
- **Needs from you:**
  - A sending domain and its DNS records.
  - An email sending account (Resend).
  - Forwarding from your support inbox.
  - The "read customers" and "read returns" permissions, and Shopify's form for name and email access.
- **Size:** L, as two PRs: email in and out first, then the agent.
- **Safety tests:**
  - Names and emails go only to Support's jobs.
  - Every reply needs your typed confirmation.
  - Each send has one fixed key, so an unknown result is checked and never sent again.
  - The deletion paths for email and customer data come first.
- **Runs in parallel with:** PRs 22 to 24. It starts after PRs 5 and 21.

### PR 26. Teammates Morrow creates (replaced by ADR-0037's follow-up PRs)
Replaced on 2026-10-25. The temporary, weaker "specialist" is gone (ADR-0037): there is one kind of agent, either built by our team and installed in one click, or created by Morrow when you approve it. The work is now ADR-0037's ten follow-up PRs, in [adr-0037-implementation.md](adr-0037-implementation.md): plan and graph; contracts with fakes; the agent-card permission packet; teammate calls in the agent loop; Morrow's new tools; the Team page and the agent card; deleting their data; plan steps that name a teammate; evals; then the switches. Since 2026-10-26 the contracts, teammate calls, Morrow's tools, the evals' follow-up and the teammate-calls switch continue as harness plan rows H5, H10, H11a, H18 and H20.
- **Delivers:**
  - **Morrow asks its teammates for answers,** and gets a structured answer back with nothing cut: a large table or file comes as an item Morrow opens page by page. It can ask several at once, ask one again, and pass what one found to the next (follow-up PRs 4 and 5, now harness plan H10 and H11a). Since 2026-10-26 it also keeps working while they run, sends them guidance, asks a follow-up that remembers everything the teammate read, spreads the same work over hundreds of products, and has big results checked by a separate reviewer before you see them (ADR-0041).
  - **New teammates on the go:** when no teammate fits, Morrow drafts one as an agent card: its name, job, instructions, the skills it uses and the tools it may use, with the permissions and Shopify access code works out from those tools. You review the exact card and press "Add to team". It then works like any other teammate, with its own permissions, notebook and model, until you remove it.
  - **One Team page:** every teammate under Morrow, marked "Built by the Morrow team" or "Made by Morrow" with the date and who approved it; pause and remove; a setting "Let Morrow suggest new teammates".
- **Needs from you:** approve each agent card you want; in a team, a second person approves it. Later, the eval round on your store.
- **Size:** ten PRs, S to L each (the plan has the sizes); the permission packet is L, as two PRs.
- **Safety tests:**
  - Only a person approves a card, never an agent and never Morrow, and the approval covers that exact card. Any edit makes a new card, and a used, expired or foreign approval document does nothing.
  - Adding a teammate is a permission change: alone, you type a confirmation phrase and wait 5 minutes, which you can cancel; in a team, a second person approves, never the person who asked for it or edited it, and you approve alone only while no one else holds the card's store permissions.
  - Nobody gives a teammate more than they hold themselves. A card that changes the store, reads orders, spends money or messages customers needs you, the Owner.
  - A card never gets anything only a person may do (approving changes, changing permissions or members, billing, deleting data, stop controls), customer names or emails, support tools, or the right to bring in or call agents. Teammates never call, hand off to or create agents.
  - Every tool call of every teammate run, the first call and every later or parallel one alike, is checked in code against your rights, the teammate's grants, Morrow's permission envelope, the store connection, the rules and the stops, and the current rights of the person who owns the teammate.
  - A teammate that read outside text marks its answer, and the mark carries into anything Morrow drafts after it; your approval never clears it. An answer that holds customer data never reaches Morrow.
  - Morrow opens only items from answers its own job received. A teammate opens only items named in its brief that came to the same Morrow job, never another person's private Ask.
  - No money cap: each teammate job holds its own credits from the workspace's balance, and a call the balance cannot cover pauses the whole request until credits are added, instead of being refused (ADR-0041 item 9). Your stop ends any job.
  - At most 10 teammates Morrow creates per workspace; Morrow may suggest removing one idle for 30 days and never removes one itself.
  - Each new kind of data has its deletion path first. Every new table is isolated per tenant.
  - The switches stay off until the deletion paths, the gateway, reservations and stops, the agent-loop switch and a passing eval round are in place.
- **If it slips:** if the checkpoint (G11) is missed, or the permission packet is not merged by 2026-12-04 (G18), agent cards move to the first fast follow after launch; asking and handing off to the teammates we build stays.
- **Runs in parallel with:** lanes D, E and G. Follow-up PR 9 merged (#81) and PR 2 is open (#79, now H5); teammate calls (H10) wait for the harness's runner, and Morrow's tools (H11a) come with PR 12a.

## Later, when you need it

- **For teammates:** invitations and roles (Owner, Admin, Member) and the hand-over step when someone leaves.
- **For outside customers:**
  - the public Shopify app and App Review;
  - Shopify billing (App Pricing);
  - a separate production copy with the stronger key setup;
  - the small home inside the Shopify admin;
  - legal pages and the listing.

  These are tracks T6, T8, T13, T15 and T17 in `docs/plan/mvp.md`.

## What does not change: the five safety rules

1. Each shop's data stays in its own workspace, and the database enforces it.
2. Every change to your store is one you approved exactly. Any edit needs a new approval, and Morrow re-checks permission just before it writes.
3. Keys and tokens live only in the broker. Never in the code, the chat, the logs, a model or a sandbox.
4. When Morrow can't tell whether something happened, it checks before trying again, and never counts it as done.
5. You can stop everything at once. "Stop AI work", "Disconnect store" and the platform stop need no second person. Agents can only suggest them.

## Risks to watch

- **Shopify's token rules.** PR 1 assumes a long-lived token for a private app. If Shopify requires expiring tokens for new apps, PR 1 also needs the token-refresh work, about one more M.
- **Until PR 5,** uninstalling the app or changing its permissions ends it for good.
- **Credits:** the 30-day grant runs out about four weeks after PR 1 unless PR 6 lands first.
- **Speed:** Morrow answers at high effort, which is slower than a quick model. "Seen by Morrow" and the live status show at once, and staging measures the first reply and each step (harness plan H19), so the targets are set with you. No time limit ends a job (ADR-0041 item 3).
- **The real store:** a bug in PR 3 could write a wrong value. The safeguards are writing only approved fields, reading every write back, starting with one product, and Undo in PR 4.
- **The merge lane,** not the coding, sets the pace.
