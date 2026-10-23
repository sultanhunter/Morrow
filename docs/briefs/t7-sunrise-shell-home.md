# T7 PR 14: the Sunrise look and Home

- Status: brief, 2026-10-23. Track T7 (`docs/plan/mvp.md`), lane D of the v1 build order. Routine (ADR-0002): a look and screens behind the existing composition; no authority, tenancy, money, provider, contract or retention change. Decision of record: ADR-0032 (Sunrise, accepted 2026-10-23). Branch `claude/t7-sunrise-shell-home`.
- Not in scope, and not approved: ADR-0033 and ADR-0034 (projects with goals, Morrow drafting plans). Nothing here builds a contract or backend for them.

## Goal

The workspace looks like Sunrise: the Shopify admin made a little warmer, agents as friendly characters, plain words. The shell and sidebar follow the boards, and Home answers "what needs me today" from the data that exists now.

## Scope

1. **Tokens.** `docs/design/tokens.json` moves to schema 2 with the Sunrise values: colours with their contrast pairs (61, all passing), Inter, the type scale, a 4 px spacing scale, radii, the six shadows, 44/48 px target floors and the 1280 px panel breakpoint. `scripts/generate-ui-tokens.mjs` validates every section as a closed shape and generates `tokens.css` and `tokens.ts`. Option 1's colour names stay as aliases until no stylesheet uses them, so parallel work in the old look still renders.
2. **Styles.** `base`, `shell`, `components`, `avatars` and `screens` stylesheets rewritten in Sunrise; every control is at least 44 px (48 below 760 px).
3. **Agent characters.** `components/avatars.tsx`: Morrow, Listings, Business Analyst, Inventory, Support, Marketing and a specialist with five props, the "Agent" and "Specialist · one-time" pills, people's initials with presence, and the store's monogram tile.
4. **Shell.** The store switcher, the Ask Morrow button on every page, Search (drawn, disabled), Home, Inbox with its count, Projects, Team (Morrow always listed), Shop knowledge, Files, Settings at the bottom, and the store connection line. Below 760 px: a 56 px top bar and the existing modal drawer. Labels only: "Work" shows as Projects, "Agents" as Team, "Assets" as Files. Route ids, paths, the route contract and its titles don't change; tab titles use the Sunrise names.
5. **Home.** The date line, greeting, one primary ("Review N items" or "Ask Morrow"), scope line and waiting chips; the cards Needs you (open questions), Recent work (goals) and Your store (connection); the ADR-0015 pre-payment notice as the one banner.
6. **Home preview switch.** The board's sections without a backend (Today, Your projects, Yesterday at a glance, Ideas, the Ask Morrow panel, pinned projects, the Team list, credits) render only from a new port method `samples.home`. The HTTP build never composes it (not_in_build, nothing sent); the fixture composes it only in the `home_preview` scenario. Every sample card says "Sample data".
7. **Entry screens.** Sign-in, workspace setup and the account screens get a top bar with Morrow's character and one centred white card. The store connection screens restyle through the shared styles only.
8. **Docs.** `docs/design/sunrise.md` (the specification the code depends on); notes in the component baseline, prototype guide and Mobbin guide.

## Interfaces touched

`docs/design/{tokens.json,sunrise.md,component-baseline.md,prototype-guide.md,mobbin-references.md}`; `scripts/{generate-ui-tokens,verify-design,ui-checks,workspace-ui-journey-lab,workspace-ui-journey-work}.mjs`; `packages/workspace-ui/src/{copy,model,port,index,tokens,workspace-data}.ts`, `components/{avatars,display,feedback,shell}.tsx`, `screens/{home,home-samples}.tsx`, `styles/*`; `apps/workspace-web/src/{app.tsx,http/api.ts,http/composed.ts,fixtures/*}`; `tests/workspace-ui-sunrise.test.mjs`. Not touched: the Inbox and review screens (PR 15), the connections screens' markup (the connect and disconnect PRs), any contract, route, migration or Worker.

## Security notes

- **The screens decide nothing.** Every action still goes through a screen whose command the server checks; Home and the sidebar only read (open questions, goals, connections) and link.
- **Default deny for the preview.** `samples.home` has no route and no contract; `http/composed.ts` keeps it uncomposed, so the production build answers not_in_build without a request (a unit test asserts zero requests). Sample data lives only under `apps/workspace-web/src/fixtures`, which the production entry can't import (`verify:workspace-web`).
- **No new origin.** No font, image or script from another host: the CSP is unchanged, and Inter falls back to the system font until a self-hosted file lands.
- **Pictures confer nothing.** A character, colour, pill or title grants no authority (CLAUDE.md, ADR-0032 item 3). People never show as agents and agents never show presence.
- **No colour literal** outside `tokens.css` (`verify:design`), and no violet in the tokens (unit test).

## Test checklist

- [x] `tests/workspace-ui-sunrise.test.mjs`: tokens (schema, floors, no violet, closed generator), the seven characters (unique clip ids, decorative or labelled, no literal), pills, the sidebar's labels over unchanged paths, titles, Home helpers, and the preview switch (HTTP sends nothing; only `home_preview` composes it).
- [x] `npm run ui:check` (fixture, every state at 1440, 768, 390 and 320 px plus the keyboard walks) with the 44/48 px floors; new cases `home/nothing_waiting` and `home/preview`. Run locally in the installed Edge, because Playwright's own Chromium isn't installed on this Mac: 260 of 261 passed, and the one failure is Edge asking for `/favicon.ico` on the first page it opens (a 404 console line Playwright's headless Chromium never produces). CI is the authority.
- [x] `npm run verify:design`, `npm run -s typecheck`, `npm run -s verify`, `npm test`.
- [ ] `lab:workspace-ui-journey` (Linux CI `ui` job): its waits now follow the new labels and Home's scope line.
- [ ] Owner: a quick look at the screenshots (build order PR 14).

## Follow-ups

A self-hosted Inter (one woff2 and its OFL licence under the workspace's own origin); the Sunrise component baseline, prototype and browser receipt; Activity under Settings needs a `settings_section` value in the route contract (a contract change, so its own PR); remove the option 1 aliases once PR 15 moves the Inbox and review screens.
