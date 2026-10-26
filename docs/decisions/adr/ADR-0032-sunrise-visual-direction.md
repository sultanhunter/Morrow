# ADR-0032 Sunrise visual direction: a warm, Shopify-admin-like look with friendly agent characters, replacing Visual option 1

- Status: Accepted 2026-10-23 (the owner: OD-2026-10-23-6 chose Sunrise; OD-2026-10-23-7 approved this record, item 32)
- Date: 2026-10-23
- Supersedes:
  - the CLAUDE.md settled constraint "Visual option 1";
  - the owner's selection of option 1 on 2026-10-06 as the look of the workspace (`docs/references/visual-foundation.md`, "Standalone visual options"; `docs/plan/build-plan.md`, "Visual option 1 is selected"). Option 1's layout stays (item 1).
- Amends: ADR-0003 decision 3's first bullet, the candidate that feature UI is built on provisionally (item 7).
- Does not change: the information architecture, screen contracts and routes (`docs/contracts/screen-contracts.md`, `docs/contracts/workspace-routes.json`); ADR-0003 decision 3's other bullets (P02.A04 and the per-slice checks); ADR-0025 item 3 (what the embedded home holds); ADR-0011's typed confirmation; any security invariant.
- Affects: CLAUDE.md; `docs/references/visual-foundation.md`; `docs/design/` (notes now; tokens, baseline and prototype in T7); `docs/plan/mvp.md` (T7); `docs/plan/build-plan.md`; `docs/acceptance/P02.md`; `README.md`.

## Context

On 2026-10-06 the owner selected Visual option 1 (`docs/references/visual-option-1.png`): a pale, calm workspace with a left sidebar, project tabs, a conversation panel and an Inbox. CLAUDE.md lists "Visual option 1" among the settled product constraints, which change only by an owner-approved ADR. A look is not on ADR-0021 item 5's list of material changes; this record exists because the constraint is settled.

On 2026-10-23, shown four directions (D1 to D4, with D1 as option 1), the owner preferred option 1 because it "looks so user friendly", not "a complex looking coded editor like ai agent harness like ui". The owner asked for a workspace for "non technical people", "somewhat like shopify UI/UX so users are already familiar with it", with references from real apps on Mobbin, and then for wider research (OD-2026-10-23-5).

The research that followed drew the same two screens, with the same words, in four friendly directions: F1 (option 1 unchanged), F2 Sunrise (the Shopify admin, made warmer), F3 Good Company (agents as friendly characters) and F4 Plain & Clear (built to be read easily). Its real-app references came mostly from Shopify's own admin (home, products index, app install consent, setup guide), with others such as Airbnb's and Deel's change summaries and HoneyBook's empty states; `docs/design/mobbin-references.md` holds the earlier sweep. The research found five problems with option 1 as drawn:
- Its violet and sparkle mark AI the way Shopify's Sidekick does. Built for Shopify requirement 4.3.5 rejects an app that uses "a color similar to Shopify's magic purple color to denote an AI related feature". That applies to Morrow's home in the admin.
- Four grey text colours sampled from the image fall below 4.5:1, down to 3.22:1 for placeholder text. Requirement 4.1.1 asks for WCAG 2.1 AA contrast. (`tokens.json`'s own pairs pass `verify:design`.)
- Agents and people share one round shape, and the main assistant has no name or face: "Ask workspace" beside a sparkle.
- "In progress" uses the accent violet, so it reads as "AI" rather than "being worked on".
- Several controls are bare 20 px icons.

The owner chose "F2 with F3s agent avatar" (OD-2026-10-23-6), and approved recording that choice as this record, replacing "Visual option 1" in CLAUDE.md, as recommended (OD-2026-10-23-7, item 32).

## Decision

1. **Sunrise replaces Visual option 1 as Morrow's look; option 1's layout stays.** Sunrise is F2's look with F3's agent characters. From option 1 it keeps the left sidebar with projects, agents and people; the central work surface with project tabs; the conversation panel, with left-aligned messages and no bubbles; the persistent Inbox; product photos and faces; and one primary button per page that names its effect. Screen responsibilities stay as `docs/references/visual-foundation.md` and `docs/contracts/screen-contracts.md` set them, and destinations and routes as `docs/contracts/workspace-routes.json` sets them. A board that names or orders a destination differently does not change the contract.
2. **The look: the Shopify admin, a little warmer.**
   - A warm grey page and a slightly darker sidebar with no rule. Content sits in white cards with 12 px corners and a hairline ring; modals have 16 px corners, and buttons, inputs, tabs and badges 8 px.
   - One charcoal primary button per page, with the admin's bevel. Other buttons are warm grey. Red is only for errors, confirmed failures and destructive actions.
   - The admin's patterns: white pill tabs, index tables with thumbnails, a setup guide with a progress bar, count chips, and at most one banner per page.
   - Status badges in the admin's shape, each with a glyph and a word from a closed list: yellow for "your turn", blue for "being worked on", green for done, orange for time running out or something to check, red for a confirmed failure only.
   - Links and focus rings in Shopify blue. Blue text always means "you can click this".
   - A sans-serif type (Inter on the boards), 16 px for body text, with tabular figures. Fonts and images are served from Morrow's own origin, as the workspace's Content Security Policy requires (`apps/workspace-web/public/_headers`).
   - Morrow is a marigold half-sun on a horizon. Marigold is a fill only, never text and never the only signal; the Inbox count is a marigold pill with a dark numeral.
   - Never: violet or lavender, a sparkle, gradients, glows, emoji, or cards with a coloured left border.
   - Starting values, from the boards: page `#F4F2ED`, text and primary `#25231F`, links and focus `#005BD3`, marigold `#F2B33D`.
3. **Agents are friendly characters; people stay people.**
   - Each agent is a simple character with a face, at most one head feature and one prop for its job (Listings holds a price tag, Inventory and Purchasing a box), in a rounded tile of its own colour. Below 24 px, a tile shows the agent's initial instead.
   - The Coordinator is shown as "Morrow": the marigold half-sun with a face. A specialist is a plain character on a neutral dashed tile, holding its skill's prop.
   - An "Agent" pill in the agent's colours follows its name wherever the page does not already say it; a specialist carries a neutral "Specialist · one-time" pill. Screen readers hear ", agent" or ", specialist, one-time".
   - People are round portraits or initials, with a presence dot and hidden text. Agents show a status word, never a presence dot.
   - Tile colours are identities, never statuses. Large characters appear only in empty states, onboarding, the agent gallery and agent headers, never beside money, errors or failures.
   - A face, colour, pill or title confers no authority (CLAUDE.md). Agent-written content always names its agent, and an approved change names both sides: "Written by Listings · Agent", then "Approved by" and the person.
4. **Plain words for non-technical people.**
   - Short sentences, at about a US grade 7 reading level. Buttons start with a verb, in sentence case. One term per concept ("Decline", never "Reject"). Dates, times and money appear as the shop's Shopify admin shows them.
   - Internal terms stay out of the interface: run, token, digest, mandate, tool call, workflow, trigger, webhook, queue, retry, scope, API, prompt, sandbox, artifact, release. The Coordinator is "Morrow", an installed agent is "added", a proposal is a "suggested change", and an unknown outcome is "Checking", never a success.
   - A choice the merchant makes is named plainly where it is made: an agent's AI model and thinking effort in its settings (ADR-0027 item 12), and the address an email is sent from (ADR-0030 item 10).
   - Plain words never change a fixed phrase or a meaning. The typed confirmation reads as ADR-0011 and ADR-0024 fix it. "Updated in Shopify" appears only after the gateway's readback. An approval says that any edit needs a new approval. A measured number names its source and time, so an agent's estimate never looks like a fact.
5. **Accessibility floors,** with WCAG 2.2 AA the design target:
   - text at least 4.5:1 against its actual background; control edges and focus rings at least 3:1;
   - every target at least 44 by 44 px, and 48 on a phone;
   - colour is never the only signal: a badge has a glyph and a word, presence has text, a progress bar has its figure in text, and added or removed words in a before-and-after are named for screen readers;
   - body text at 16 px and no running text below 14 px; a visible focus ring on every focusable element; full keyboard reach; non-essential motion off under reduced motion.

   `npm run ui:check` checks them on every slice; T7's token change raises its target floor from 24 to 44 px. ADR-0003 decision 3's checks at 1440, 768, 390 and 320 px stay.
6. **The embedded home looks like the Shopify admin.** Inside the admin, Morrow's home uses Polaris web components with the admin's own greys, cards, type sizes and badge colours, and App Bridge for its title bar and toasts, as Built for Shopify requirement 4.1.1 asks. Only Morrow's mark and the agent characters come from Sunrise. It shows no Shopify bag logo, no Sidekick icon and no purple. What it holds, who may approve there and where stops live stay as ADR-0025 item 3 and its owner questions 1 and 4 set them. Where a board differs (the admin-home board's "Stop all AI work" button), ADR-0025 wins.
7. **Tokens, prototype and code change in the UI track, not in this record.**
   - This record changes no token, generated file, contract or code. `docs/design/tokens.json`, `prototype.html`, `component-baseline.md` and the provisional port in `packages/workspace-ui` stay, with notes that they show option 1.
   - T7 (`docs/plan/mvp.md`) replaces them in small routine PRs with tests: the Sunrise specification in `docs/design/`; Sunrise values and contrast pairs in `tokens.json`; `tokens.css` regenerated by `npm run ui:tokens`, still with no colour literal outside it; the characters as components; a new component baseline and prototype with their own browser receipt; and the boards' screens rebuilt in `packages/workspace-ui`.
   - Amends ADR-0003 decision 3's first bullet: once T7's token change merges, feature UI is built provisionally on the Sunrise candidate. Until then the merged option 1 port stays, styled only through the tokens, so no screen hard-codes option 1. P02.A04 still gates acceptance, Verified status and any merchant pilot, and it tests Sunrise.
   - Exact values, sizes, drawings and placements within items 2 to 6 are routine design-system changes in T7's PRs. Changing a rule in items 1 to 6 needs a new ADR.

## Security invariants touched

None. A look changes no authority, tenancy, approval, budget, credential or provider rule. Three rules owned elsewhere are restated, not changed:
- **Agent titles confer no authority** (item 3): `agent-authority.test.mjs`.
- **Digest-bound approvals** (item 4): the interface shows the exact change and says that an edit needs a new approval, never the digest. `approval-records.test.mjs`, `review-policy.test.mjs`.
- **Default deny** (item 2): no third-party font or asset host; the workspace's Content Security Policy is checked by `npm run ui:check`, and the embedded home's by ADR-0025 item 3.

## Consequences

- CLAUDE.md's constraint line names Sunrise and this record. `docs/references/visual-foundation.md`, `docs/design/component-baseline.md`, `prototype-guide.md` and `mobbin-references.md`, `docs/plan/build-plan.md`, `docs/acceptance/P02.md` and `README.md` gain short notes; T7 in `docs/plan/mvp.md` names the work. No token or prototype changes here.
- T7 carries the cost: new tokens, a self-hosted font, seven characters (Morrow, one for each of the five launch agents in `docs/plan/mvp.md`, and a generic specialist), a new baseline and prototype, and the screens. The merged option 1 port restyles through its tokens rather than being rewritten. Code comments and the route contract's description that say "option 1" change with T7's PRs.
- The Mobbin guide's patterns still apply. Its section 2 look rules (the violet count and "In progress", underline tabs, round agent glyphs) give way to Sunrise; its layout and behaviour rules stay.
- The characters are simple drawn shapes, good enough for the unlisted launch. A professional illustrator before the public listing spends money and needs its own owner decision.
- Risks: Sunrise is the least distinctive of the friendly directions next to the Shopify admin; characters drawn badly look childish; two accents, marigold and Shopify blue, need discipline. P02.A04's sessions on the owner's store and with the first merchants (ADR-0023) test it.

## Alternatives considered

- **F1, Visual option 1 unchanged** (D1 in the first round). No switching cost, and the owner liked its friendliness. But its violet and sparkle conflict with Built for Shopify 4.3.5 in the admin home, four greys in the image fail contrast, agents share people's round shape, and the main assistant has no name or face. Sunrise keeps its layout, which is what the owner liked.
- **F2 alone, with its line-object emblems for agents.** Closest to the admin, but the owner chose F3's characters, which mark agents most clearly.
- **F3 Good Company alone:** cream page, teal accent, pill buttons, Figtree. The warmest and clearest about agents, but further from the admin: its embedded home falls back to Polaris, and the workspace loses the Shopify familiarity the owner asked for.
- **F4 Plain & Clear:** Atkinson Hyperlegible Next at 17 px, outlined boxes, 48 px buttons. The easiest to read, but the plainest look, with the longest pages. Its floors (no text below 14 px, 44 px targets, a word on every badge) are kept in items 2 and 5.
- **D2 to D4 (first round):** D2 Paper & Ink (warm editorial, serif headings, ink blue), D3 Ledger (black and white, monospace names) and D4 Control Room (dark and dense). The owner preferred option 1's friendlier style: D2 "looks good but not as good", and the others read as the coded, agent-harness look the owner did not want (OD-2026-10-23-5).
- **"Option 1, corrected":** option 1's tokens with an ink-blue accent, square agent tiles and no sparkle. The smallest change, but it keeps option 1's cold neutrals and faceless agents.

## Approval

The owner's statements in chat, verbatim, on 2026-10-23 (IST).

- **The choice (OD-2026-10-23-6),** after seeing the friendly directions F1 to F4 on the design canvas and as concept images:

  > F2 with F3s agent avatar seems a good option and tell me the questions i need to answer

- **The approval (OD-2026-10-23-7),** after reading a plain-language list in which item 32 read "Visual ADR: record Sunrise as ADR-0032, quoting your message, and replace 'Visual option 1' in CLAUDE.md with it", recommended:

  > approve all as recommended and user should be able to select model and thinking effor for each agent with the main agent set to opus 5.5 high by default and specialist at opus 5.5 medium for email the shop owner should be able to link there emails which will be used for any particual email job like suppose user linked multiple emails(our morrow email will be linked by defualt with user shop name, something like usershopname@morrow.com and selected by default unless user link there emails) and then whenever any email sending related prompt comes user should be able to select which email to choose for that, for now no need to develop the actual capability to link the email but architecture wise it should be like how i explained so we can just add the feature to link users email and it will show in the emails available to use list.

What they approve: Sunrise as Morrow's visual direction, this record, and the CLAUDE.md line that replaces "Visual option 1".

## Amendments

### 2026-10-26: item 1, your own messages on the right in the Morrow conversation (ADR-0040, proposed and conditional)

Proposed, not decided, and only if the owner answers ADR-0040's owner question 34 (Q-adr-0040-0041-owner-questions) yes: in the Morrow conversation only, a person's own messages would sit on the right on a light warm-grey surface, with no coloured bubble and no emoji, while agents stay on the left with their character; project conversations keep left-aligned rows. The text above stands until then.
