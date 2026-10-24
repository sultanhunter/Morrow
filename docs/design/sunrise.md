# Sunrise: the workspace look (ADR-0032)

Status: T7 PR 14, 2026-10-23. The machine-readable values are `tokens.json` (schema 2); `npm run ui:tokens` generates `packages/workspace-ui/src/styles/tokens.css` and `tokens.ts` from it, and `npm run verify:design` checks the generated files, every contrast pair and that no colour literal exists outside `tokens.css`. The drawn boards and the full design brief are on the owner's private Sunrise canvas; this page is the part the code depends on. Where it and ADR-0032 differ, the ADR wins.

Sunrise is the Shopify admin a merchant already knows, made a little warmer, with each agent drawn as a friendly character. The audience is non-technical shop owners: screens feel like Shopify, never like a coded tool.

## Colours (tokens.json `color`)

| Role | Tokens | Rule |
| --- | --- | --- |
| Surfaces | `page` #F4F2ED, `sidebar` #EDEAE3 (no rule beside it), `surface` white cards, `subtle` table heads and row hover | Content sits in white cards on the warm page |
| Text | `text` #25231F, `reading` paragraphs, `subdued` meta | 4.5:1 on every surface they sit on |
| Controls | `controlBorder` #8A847A (3:1 on surface, page, sidebar, subtle), `focus` #005BD3 2 px ring with a 2 px gap | Every focusable element shows the ring |
| Actions | `primary` charcoal with the admin's bevel (one per page), `secondary` warm grey for every other button, `critical` only in destructive confirms | Buttons start with a verb, sentence case |
| Links | `link` #005BD3 | Blue text always means "you can click this" |
| Morrow | `marigold` #F2B33D is a fill only (the sun, the Inbox count pill with `countInk`); `morrowSurface` for Morrow's information strips | Never text, never the only signal |
| Badges | `caution` your turn, `info` being worked on, `success` done, `warning` time or attention, `critical` confirmed failure only, `neutral` | Each badge has a glyph and a word (see Badges) |
| Banner heads | `infoTint`, `warningTint`, `successTint`, `criticalTint` | The title sits in the tone's text colour; the body on white |
| Agents | `agent<Name>Tile`, `Body`, `Ink` for Morrow, Listings, Business Analyst (`analyst`), Inventory, Support, Marketing and the generic Specialist | Identities, never statuses |

Never: violet or lavender (Built for Shopify 4.3.5 rejects AI purple in the admin; a unit test checks every token's hue), sparkles, gradients, glows, emoji, or cards with a coloured left border. `legacy_color_aliases` keep option 1's names (`canvas`, `border`, `accent`, `accentSurface`, `danger`, `dangerSurface`) pointing at Sunrise values for screens not yet moved; remove them once no stylesheet uses them.

## Type, spacing, shape

- **Inter**, falling back to the system sans-serif, with tabular figures. Fonts load only from Morrow's own origin (the workspace CSP allows nothing else); until a self-hosted Inter file lands, the fallback renders wherever Inter isn't installed.
- Scale (`type.scale`): H1 30/36 700 (24/30 on a phone), detail 22/28, card title 18/26 650, body 16/24, reading 16/26, nav 15/22, button 16/20 600, small and meta 14/20, metric 28/34, count numerals 13/16. Nothing but a count numeral is below 14.
- Spacing is a 4 px scale; `--space-N` is N × 4 px (`--space-5` is 20 px).
- Radii: 8 controls, tabs, badges and chips; 10 inner blocks; 12 cards and banners; 16 modals and entry cards; round for people, pills and counts.
- Shadows: the card ring, the selected-pill ring, the primary bevel, menu, modal, toast. Nothing else.
- Targets (ADR-0032 item 5): 44 × 44 px, 48 below 760 px. `--target` carries the floor; `npm run ui:check` holds every control to it (a checkbox or radio by its label).

## Shell and navigation

The sidebar draws the route contract's seven destinations (`docs/contracts/workspace-routes.json`, `sidebar.primary`) in the contract's order, with four labels changed: Home, **Projects** (route `work`), Inbox (with the marigold count of what waits for the person), **Team** (route `agents`), **Files** (`assets`), **Shop knowledge** (`knowledge`), and Settings at the bottom. Routes, paths, order, the sidebar's link targets and the contract's titles are unchanged (ADR-0032 item 1: a board that names or orders a destination differently doesn't change the contract); tab titles use the Sunrise names (`copy.routeTitles`; a settings section by its own name).

Above the destinations: the store switcher (the shop's serif monogram tile), the **Ask Morrow** button (on every page; the contract's entry action), and Search (drawn, disabled until search exists). Under Projects, pinned projects (each on its `project` route); under Team, Morrow (always; its row opens Ask Morrow, because the Coordinator is no installation), then installed agents (their `agent` page) and people (Settings > People and roles), the contract's `people_and_agents` targets. At the bottom: the store connection line ("Shopify connected"), the credit balance (when known; display only, opening Settings > Usage) and Sign out. The Inbox count and the connection line are read again whenever the page changes, a command starts or settles (an answer, a store link) or a Retry is pressed, under the shell's refresh mark. Home reads them under the same mark, so the sidebar and Home settle on one reply, and a Retry on Home reads the sidebar's copy again too. A re-read that gets no answer (unavailable, offline, rate limited) keeps the last reply that answered. Pages that hold a command (the store connection screens, Ask Morrow) read the connection once per page and on their own Retry instead, so a background re-read never takes a command's in-flight or unknown outcome, and its Check again, off the screen. Below 760 px the sidebar becomes a labelled modal drawer behind a 56 px top bar (menu, store, Ask Morrow, Inbox with its count).

**Settings** (`components/settings-frame.tsx`, the ConnectStore board): every settings screen (`settings`, `settings_section`, `connections`, `connection`) sits beside a white sub-navigation card: Plan and credits, People and roles, Notifications, Model default and Shopify connection, each on its contract path (`/settings/<section>` or `/connections`). **Activity** is listed there, under Settings and never in the sidebar, as a placeholder that isn't a link ("Activity, not in this build yet" to a screen reader) until the activity log has a route; that needs a `settings_section` value in the route contract, its own change. Below 1120 px the card sits above the screen and its items wrap.

## Agent characters (`components/avatars.tsx`)

- A 40 × 40 viewBox, drawn at 24 to 96 px; below 24 px the tile shows the agent's initial.
- A rounded tile (30% radius) in the agent's colour; the shared body shape; two eyes and a smile; at most one head feature; one prop for the job in the lower right (Listings a price tag, Business Analyst a clipboard with a rising line, Inventory a taped box, Support a headset, Marketing a megaphone). Morrow is the marigold half-sun with a face. A specialist is plain white on a dashed neutral tile, holding its skill's prop (calendar, envelope, magnifier, pencil, chart).
- Colours come from tokens through classes; each clip path id is unique per use.
- Decorative (`aria-hidden`) when the name is printed beside it, `role="img"` with the name when it stands alone.
- The **Agent** pill follows an agent's name wherever the page doesn't already say it (not in the sidebar's Team list or the agent gallery); screen readers hear ", agent". A specialist carries a neutral "Specialist · one-time" pill (", specialist, one-time").
- Large characters appear only in empty states, onboarding, the agent gallery and agent headers, never beside money, errors or failures. A face, colour, pill or title confers no authority.

## Badges

A 28 px badge: a 14 px glyph and one word from a closed list, in a tone. Dashed ring: Needs review, Needs you, Ready for you. Half fill: Working. Check: Done, Connected, Updated in Shopify, Active, On track. Alert: Behind, Alert. Clock: Expires soon. Three dots: Checking (an unknown outcome is never shown as success). Pause, minus, plus and the triangle (critical: Couldn't finish, Not sent) complete the set. Identity is a pill, never a badge.

## Home (`screens/home.tsx`)

"What needs me today, what happens next, and how is the shop doing?" The date line, a greeting, the one primary ("Review N items" when something waits, else "Ask Morrow"), the scope line naming the shop, the waiting chips, then cards. Only an answered open-questions read can say "Nothing needs you right now" and offer Ask Morrow as the primary: when that read is denied (the governance-only first-run Home), offline, rate limited or failed, the scope line stays neutral, no primary shows, and the Needs you card carries the state. Built on the data that exists today: **Needs you** (the person's open questions, most urgent first), **Recent work**, **Your store** (the connection). The ADR-0015 pre-payment notice stays as the page's one banner.

The board's other sections (Today, Your projects, Yesterday at a glance, Ideas, the Ask Morrow panel, pinned projects, the Team list and credits) have no backend yet: the contracts and backend of ADR-0033 and ADR-0034 (accepted 2026-10-24) land in their own PRs. They render only from the `samples.home` port method, which the HTTP build never composes and the fixture build composes only in its `home_preview` scenario, and each says "Sample data" on screen: a note on each card, and in the sidebar a tag over the pinned projects and over the sample Team rows and on the credits line (screen readers hear ", sample data" on each sample link). Dismissing an idea moves focus to the next idea's Dismiss, or to the Ideas heading once none are left; the card then stays, saying so.

## Entry screens (the SignIn board)

Sign-in, signed out, workspace setup and the account screens: a 64 px top bar over a rule with Morrow's character and name, then one centred white card on the warm page (504 px at most, `content_width_px.entry`; radius 16; padding 20 to 32). Sign-in and signed out open with the horizon picture (`HorizonPicture`: Morrow at 72 on an ink horizon with a sand hill and a sage leaf, 160 × 120, decorative). The card's primary action runs its full width. The board's "Get help" link and terms line wait for pages to point at.

## Still to come in T7

A self-hosted Inter; the Sunrise component baseline and prototype with their own browser receipt (`prototype.html` and `browser-checks.json` still show option 1); the Inbox and review (PR 15); agent pages, the catalogue and Settings (PR 16); the empty-state pictures beyond the entry screens; the embedded home in the admin's own Polaris look (ADR-0032 item 6).
