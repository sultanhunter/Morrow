# Sunrise: Team, agent pages, Add agents and Settings (T7, v1 PR 16)

- Status: brief, 2026-10-23. Branch `claude/t7-sunrise-team-agents-settings`, one PR built on `main` beside PR 14 (the Sunrise shell and Home), which is not merged yet. Change class: routine under ADR-0002 (UI on fakes, wording, tokens): no authority, tenancy, money, provider, retention or route change. Look: ADR-0032 (Sunrise) and the drawn boards Team, Agent, AgentStore, PlanCredits and EmailAddresses. Structure: the UX recommendation's sections 2 and 3 (Team lists Morrow, agents and people; plain words).
- ADR-0033 and ADR-0034 (projects with goals, Morrow drafting plans) are proposed, not approved. Nothing here builds a contract or backend for them: "Works toward" and "Works in" are fixture text only.

## Goal

The owner can see who works in the shop (Morrow, the added agents, the one-time specialists and the people), open one agent's page, change how an agent thinks (model and thinking effort), browse the agents Morrow offers and add one through a server-built document, and read Settings: Plan and credits, Email addresses (the shop's Morrow address, with linking marked "Coming soon") and People and roles. Shop knowledge and Files get simple read-only pages.

## Scope

- **Screens** (`packages/workspace-ui/src/screens/`, each in its own file, styled by `styles/sunrise-team.css`): `team.tsx` (Team and the "Change how it thinks" dialog), `agent-page.tsx`, `add-agents.tsx`, `settings-pages.tsx` (Settings home, Plan and credits, Email addresses, People and roles), `library.tsx` (Shop knowledge, Files). Shared Sunrise parts in `src/sunrise/`: the seven agent characters and people initials (`avatars.tsx`), badges, pills, cards, the permission list, progress bars, the thinking picker and the settings menu (`parts.tsx`), and the screens' copy (`copy.ts`).
- **Routes, unchanged** (ADR-0032 item 1): `agents` is Team, `agent` an agent's page, `agent_store` and `agent_listing` Add agents, `knowledge` Shop knowledge, `assets` Files, `settings` the Settings home; `settings_section` `usage` and `billing` are Plan and credits, `people` People and roles, `notifications` Email addresses (see the open question), `governance` keeps the existing model-default screen. The sidebar labels stay PR 14's.
- **Data, behind default-off switches.** A UI-only port group (`team.*`, `settings.*`, `library.*`; view models in `src/team-model.ts`) that only the fixture adapter implements. The production build leaves every one uncomposed, so it sends nothing and those destinations show the existing "not built yet" state. T2, T4, T11 and T13 compose them when their routes exist.
- **"How this agent thinks"** shows Haiku 5.5, Sonnet 5.5 and Opus 5.5 at Low, Medium or High. Where governance already exists, it is bound to it: the Listings agent's choice is the workspace model default (`models.list`, `models.reviseDefault`, with the expected revision); a choice above the member ceiling cannot be saved and links to Settings to raise the limit, which this page never does. Every other agent, Morrow and new specialists use `team.reviseThinking` (fixtures only). Only someone the server allows sees the controls; the fixture models the rule (Owner for everything, Admin for added agents only, members for nothing; ADR-0027 item 12).
- **Adding an agent** asks the server for the install document (`team.addDocument`), shows exactly that document (what it may and may not do, the Shopify access it needs, its model, effort and credit limit, and who reviews it), and confirms it by its fingerprint and single-use value (`team.addConfirm`), as Listings' enable does.
- **Tokens:** Sunrise colours enter `docs/design/tokens.json` under a `sunrise` prefix with their contrast pairs; `tokens.css` is regenerated. Option 1's tokens and every other screen are unchanged. When PR 14's tokens land, the prefixed names map onto them in one rename.

## Interfaces touched

`packages/workspace-ui` (port, index, new files above, one stylesheet import), `apps/workspace-web` (route cases in `app.tsx`, `guardPort`, the HTTP port's uncomposed group, the fixture adapter and scenarios `team_member`, `team_admin`), `docs/design/tokens.json` and the generated `tokens.css`, `scripts/ui-checks.mjs` (new cases; the "unavailable destination" case moves to `catalog`). No server route, contract, schema, migration or dependency changes.

## Security notes

- The screens decide nothing. Each change is a command the server (here the fixture) accepts or refuses; a refusal, conflict or unknown outcome shows the existing feedback ("Check again" never reads as saved).
- No input reaches a store, an email or a model. Model and effort are closed keys of the catalogue; the credit limit is a bounded integer; the add confirmation carries only the server's fingerprint and single-use value.
- A face, colour, pill or title confers nothing; the copy says so on Team. No internal words (run, token, digest, scope, prompt and the rest of ADR-0032 item 4) appear in this copy; a test checks it.
- Files has no upload (uploads wait for P09.T05): "Upload a file" is marked "Coming soon". Email addresses sends nothing and links nothing.
- Fixture data is synthetic (Linen & Form); no real shop, person or address.

## Test checklist

- [x] `tests/workspace-web-team.test.mjs`: the port group is uncomposed over HTTP and sends nothing; the fixture's reads, the thinking rule per role, the revision conflict, the add document bound to its fingerprint and single use, the catalogue mapping of the thinking options and the ceiling, avatar markup, and the banned-word scan.
- [x] `npm run -s typecheck`, `npm run -s verify` (tokens, contrast pairs, colour literals), `npm test`.
- [ ] `npm run ui:check`: new cases for Team, an agent page, the thinking dialog, Add agents and its consent dialog, Plan and credits, Email addresses, People and roles, Shop knowledge and Files at four widths (locally with the installed Edge where Playwright's browser is absent; CI is the authority).
- [ ] AI review (separate context, same model family); hosted `foundation`.

## Open questions (owner)

1. **Email addresses' address.** The route contract has no settings section for it; this PR uses `notifications`, the closest one (Shopify keeps the sender address under Notifications too). A dedicated section is a route-contract change.
2. Activity and "Stop all AI work" in the Settings menu, Pause, Remove and Renew on an agent's page, and changing the sender name or support address wait for their backends (PR 15, ADR-0024, T11); they are not drawn as working buttons.
