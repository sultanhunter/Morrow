# Mobbin design references for Morrow

Date: 2026-10-19. Supporting reference for UI packets. It changes no plan, contract or token. Where it conflicts with `docs/plan/build-plan.md`, `docs/contracts/screen-contracts.md`, `docs/design/component-baseline.md`, `docs/design/tokens.json` or a packet, those win.

**Sunrise (ADR-0032, 2026-10-23).** ADR-0032 replaced Visual option 1 with Sunrise. Where this guide says option 1 is the direction or wins a conflict (rules 1 and 2, section 2), Sunrise does once T7 (`docs/plan/mvp.md`) lands its tokens and baseline. Section 2's look rules (the violet count and "In progress", underline tabs, round agent glyphs) give way to Sunrise; its layout and behaviour rules, and the references' patterns, stay.

## 1. Purpose and rules

This guide picks the strongest Mobbin references for each Morrow screen family and turns them into patterns that `packages/workspace-ui` (`components/`, `screens/`, `styles/{base,shell,components,screens}.css`, `copy.ts`) and `apps/workspace-web` (routes, ports, fixtures) can build.

1. **Option 1 is the direction, and it is settled.** `docs/references/visual-option-1.png`, `tokens.json`, the component baseline, the screen contracts and `docs/design/prototype.html` set how Morrow looks. Mobbin informs structure, states, wording and behaviour only.
2. **Option 1 wins any conflict.** Section 2 lists the conflicts found in the sweeps.
3. **Cite by `mobbin_url`.** Do not download, copy, trace, screenshot or embed Mobbin images in the repo, PRs, tests or artifacts.
4. **Borrow patterns, not brands.** Do not reuse reference apps' names, icons, illustrations or copy.
5. **Morrow's rules beat any pattern.** Reading never approves. An approval binds one exact proposal revision and happens in Review, never in chat. Unknown outcomes stay visibly unknown until reconciled. No success wording before verification. Agent titles carry no authority. Kill switches are human-only (an agent may only propose one).
6. **Packet copy wins.** For example, the `OutcomeNotice` and account-landing strings in `docs/packets/P14.T01a.md` override wording suggested here.
7. **Synthetic content stays marked.** Prototype and fixture data never looks like a real store.

Sources: seven Mobbin MCP sweeps on 2026-10-19 (web platform, plus one phone reference), one per screen family. The sweep agents looked at the returned screens. This guide selects 5 to 8 references per family and reconciles them with option 1 and the repo contracts. It ran no new searches.

### Token shorthand

| Shorthand | tokens.json | Value |
| --- | --- | --- |
| canvas / surface | `color.canvas` / `color.surface` | #F4F5F7 / #FFFFFF |
| text (charcoal) / subdued | `color.text` / `color.subdued` | #202223 / #61656A |
| border / controlBorder | `color.border` / `color.controlBorder` | #D8DBE0 (separators) / #8C9196 (editable controls) |
| accent / accentSurface / focus | `color.accent` / `color.accentSurface` / `color.focus` | #6356BA / #EEEBFB / #5948A9 |
| success, warning, danger | `color.success`+`successSurface`, `warning`+`warningSurface`, `danger`+`dangerSurface` | status only |
| type | `type.title_px` 28, `section_px` 20, `reading_px` 16, `body_px` 14, `caption_px` 12, `utility` mono, `line_height` 1.5 | system font stack |
| radius | `radius_px.control` 8, `surface` 10, `selection` 6 | |
| widths | `content_width_px.sidebar` 232, `conversation` 336, `pane_collapse_below` 1120, `navigation_collapse_below` 760 | frames 1440 / 768 / 390, reflow at 320 |
| motion | `motion.duration_ms` 120, `reduced_motion` disable_nonessential | |

- **Charcoal primary:** a button filled with `text`, labelled in `surface`, with `radius_px.control`. Each view has one, and its label names the effect.
- **Token gaps:** elevation for menus and drawers, scrim, hover tint, agent identity tint, and control heights (32 / 40 / 44). Add them as routine design-system changes in the PR that first needs them, keeping the option 1 look.

## 2. Where option 1 overrides the references

These points come from `visual-option-1.png`. Where a sweep disagrees, follow this list.

- **Main surface.** The white `surface` column runs full height beside the `canvas` sidebar, separated by a 1px `border`. It is not Linear's inset floating panel.
- **Sidebar order.** Workspace switcher (square brand mark, name, chevron), then search, Ask workspace, the destinations, and the Projects, Agents and People groups. Settings and the "Shopify connected" row are pinned at the bottom.
- **Inbox count.** A small round count pill in `accent` with a `surface` numeral. It is never red and never a bare dot. The sweeps suggested a subdued number; option 1 wins. The sweeps' counting rule still applies: it counts pending decisions, not unread items.
- **Project tabs.** Brief, Products, Creative and Results are underline tabs. The selected tab is bold with an underline. They are not pills.
- **Project header.** A breadcrumb ("Projects / Autumn collection"), then a 28px title, then the participant avatar stack with an add button. One charcoal primary sits on the right and names the effect and count ("Review 3 changes"). A `subdued` scope line under the title reads "Linen & Form · Main store".
- **Conversation pane.** The header reads "Project conversation" with the participant stack and an overflow count. Every message is a left-aligned row (avatar, name, time, text) with no bubbles, including your own. Linked-output cards read like "Product content · 2 updates ›". A running line sits above the composer ("Creative Producer is preparing the last image…"). The composer reads "Message the team or @ an agent…", with attach, @ and send buttons.
- **Agent avatars.** Round, with a glyph on a tinted circle; people use photos or initials. Keep this shape. Add a text "Agent" tag wherever identity must be read: owner columns, pickers, Activity and Members. The sweeps' rounded-square agent mark would be a baseline change for P02 review, so do not adopt it here.
- **Status chips.** A dot plus text on a tinted surface. "Needs review" uses `warning` on `warningSurface`. "In progress" uses `accent` on `accentSurface`, as drawn. Green is only for verified or connected, and red only for failed or blocked.
- **Brief tab.** A document heading, an "updated by · date" line, the objective, a products table (thumbnail, name, variant line, owner, progress) and a Decisions list.

## 3. App shell and project workspace

**Informs:** `AppShell`, sidebar, `WorkspaceSwitcher` (menu, and a bottom sheet on phones), project header, artifact tabs, environment and restriction banners, `StatusRegion` and toast, narrow-width layouts, Home chrome.

**References**
- [Attio — company record with counted tabs and right pane](https://mobbin.com/screens/2b32899d-6868-4595-a3b9-4d9eb8fe7642): header order (breadcrumb, title with actions, meta row, tabs with counts) and a right pane with its own tabs. Sibling [record with sidebar count and n-of-N](https://mobbin.com/screens/825084e6-a0f2-4f5c-9797-49a771fa16a3).
- [Linear — project overview with properties pane](https://mobbin.com/screens/fed68772-ccc3-48be-8c28-3691a441728b): calm density, a pane toggle at the end of the tab row, and an inline properties row. Ignore its inset panel.
- [Linear — workspace menu and Switch workspace](https://mobbin.com/screens/e8fe60b4-6db4-4485-99b8-3395d69ea7db): switcher anatomy, with a check on the current workspace, per-workspace counts, and account actions in the same menu.
- [Notion — AI chat docked beside a document](https://mobbin.com/screens/7e25606f-869e-4867-8400-cfac83d7e1b1): a contextual pane with collapsed reasoning and a pinned composer. See also the empty pane with context chips ([a2f2432c](https://mobbin.com/screens/a2f2432c-3e0f-4c82-a191-b24b3cfb88cb)) and the referenced passage highlighted in the document ([fa353249](https://mobbin.com/screens/fa353249-a50d-499c-9c72-ffc28f1bd0f0)).
- [Stripe — restricted banner, single primary, toast](https://mobbin.com/screens/e0c8673e-3c63-4a81-895c-e6a71cf5c7c6): the banner sits above the title with one recovery action. Sibling [persistent test-mode bar](https://mobbin.com/screens/62ca0ad2-5291-4edb-8238-f19a2805f5f3) for marking synthetic data.
- [Ditto — attributed Activity pane](https://mobbin.com/screens/1c540e1a-3546-4c62-9028-311117ce9739): actor, action, object and time on each entry. Sibling [before and after value chips](https://mobbin.com/screens/d520c34f-cdfc-4be1-be7d-f6400d950750).
- [Linear Mobile — project on a phone](https://mobbin.com/screens/f8e3aa03-00f2-4985-a6ae-1055ae0f4144): tabs survive at phone width and properties wrap as chips. Sibling [workspace bottom sheet](https://mobbin.com/screens/2c26458a-0755-4391-8832-51fc9048762e).
- [ClickUp — mobile navigation drawer](https://mobbin.com/screens/c6c7f577-dc92-45a5-97d0-adeae9f71b3b): the drawer keeps the desktop sidebar's content and order over a dimmed page.

**Patterns to adopt**
- **Shell grid** (`styles/shell.css`): `[sidebar 232][main 1fr][pane 336]`. Pane collapse uses a container query on the work area (`pane_collapse_below` 1120). Navigation collapse uses the viewport (`navigation_collapse_below` 760). Do not use a host or device flag for either.
- **Sidebar rows.** 32px tall, with a 16px icon and a 14px label. The selected row has an `accentSurface` fill, `accent` text and `radius_px.selection`. Hover uses a neutral tint, not accent. The current location has `aria-current="page"`.
- **Switcher menu.** It lists workspaces from `GET /workspaces`, with a check icon plus text on the current one and a role label and pending-decision count on each. Below a divider come All workspaces (`/`) and Sign out. Choosing one navigates to `/w/:id` and drops that workspace's caches. The leave guard applies.
- **Inbox entry.** The accessible name is "Inbox, 3 decisions pending". Opening or reading an item never changes the count; only answering, approving, declining or granting does.
- **Groups.** Projects, Agents and People are collapsible (a disclosure button with `aria-expanded`). Show at most about 8 rows, then "View all in Work".
- **Footer.** Settings, then the Shopify status row, then the user menu. The status row always carries text: "Shopify connected" (success dot), "Shopify needs reconnect" (warning icon) or "No store linked" (neutral). It links to Settings › Connections. No promotional cards.
- **Project header, top to bottom.** First the breadcrumb row, with the participant stack, overflow and pane toggle on the right. Then the title row: a 28px title, a status chip, and the charcoal primary with outline secondaries to its left. Then the scope line: the store chip, owner, credits held, and "Updated 3 h ago".
- **Store chip.** It shows the pinned operation target (the shop domain). It never follows a list filter.
- **Artifact tabs** (`role="tablist"`, roving tabindex, arrow keys). A tab may show a subdued count in a `tab-count` span. Switching tabs keeps each tab's scroll position and unsaved draft. Deep links survive reload.
- **Pane toggle.** An icon button with an accessible name ("Show conversation") and `aria-expanded`. When the pane is collapsed, the toggle shows a new-message count, so the pane stays reachable.
- **Banners.** Full width, between the header and the content, never inside a card. Synthetic data: "Synthetic data. Nothing here reaches a real store." This one cannot be dismissed. Disconnected: "Shopify needs reconnecting. Agents can draft but cannot publish." with Reconnect. Use `warning` tokens, and `danger` only when work is actually blocked.
- **Toasts.** Short confirmations only ("Draft saved · View"), bottom centre, at most 5 s, announced through a polite `StatusRegion`. Questions, approvals, failures and unknown outcomes always go to Inbox and Activity.
- **Loading.** Render the header, tabs and pane skeleton at their final sizes. Never put a spinner in place of the shell.

**Avoid**
- Dark or saturated sidebars, hero cover images on projects, and upsell or onboarding cards in the sidebar.
- Red Inbox dots, and counts of unread items.
- Icon-only rails at desktop widths. A sidebar that drills in and hides the main destinations (Vercel's "‹ CDN").
- Chat as the centre of the page. Inline Apply, Approve or Publish in chat. Model pickers in the composer.
- More than the four artifact tabs. Floating support bubbles over the composer or a sticky footer. A phone bottom tab bar that duplicates the drawer.
- Empty chart tiles on project pages. Use a stated empty state with the next action.

## 4. Work, tasks and Home

**Informs:** the Work list and board, the Coordinator suggestions block, the project Brief header and latest update, task detail (properties, outputs, sub-tasks, dependencies, agent run block, Results), the Home attention queue and panels, and the empty and denied states.

**References**
- [Linear — grouped issue list with an agent assignee](https://mobbin.com/screens/0ac97560-1aef-4907-a356-8c18c749437b): people and an agent share one owner column in a calm, single-line grouped list.
- [Linear — project board with Hidden columns rail](https://mobbin.com/screens/410846e7-09d4-4ed8-baf2-ec94d96c29f4): count chips, collapsed terminal columns, and a "hidden by filters" footer.
- [Linear — project overview with Latest update](https://mobbin.com/screens/e88b6bd7-3d4b-4e1e-8cd7-a9d2a6852795): a health label, a "since last update" diff, and progress counted from real items.
- [Qatalog — task detail with Blocker property](https://mobbin.com/screens/ea750733-550c-4a35-860a-043820104ece): the calmest detail view, with a key/value properties list, sub-task rows and old → new activity lines.
- [Jira — sub-tasks, linked items, activity tabs](https://mobbin.com/screens/b749e4c3-1ad7-4e87-9e8e-6c2a2d69f2f4): a counted segmented progress bar and typed relations showing live status.
- [Relevance AI — agent task run](https://mobbin.com/screens/db919f38-24cb-4151-b995-2781392d7db2): a "Triggered by" brief card, collapsed steps, and the credits used, actions and run time.
- [Devin — evidence card and collapsed steps](https://mobbin.com/screens/8a2e6a33-0453-4091-8c92-3bf960adec85): counted verdicts, attachment rows, and an explicit "Stopped working" line.
- [Deel — Home attention to-dos by type](https://mobbin.com/screens/6bd4989c-7a50-413e-be7e-e955b2394a29): an attention queue grouped by type, with counts and one entry action per type.
- Also useful: [hilos — orchestrator proposals above tasks](https://mobbin.com/screens/51b79e71-d53e-4c28-8ef7-0dccb025544c) for the Coordinator block, and [Ditto — calm Home section cards](https://mobbin.com/screens/56ca05d3-64ea-452b-b6cc-06090a23f314) for Home spacing.

**Patterns to adopt**
- **Work list.** One white `surface` (`radius_px.surface`, 1px `border`) grouped by status. Group headers carry a label, a count, a disclosure button and "+ Add task". Rows are single-line, at least 40px tall, with 14px text. Columns: status icon with text, ID, title (truncated, never shrunk), project, store chip (shown only when it differs from the view), owner, a dependency badge, credits held, and updated time. Each row is a link.
- **One owner column.** A person shows an avatar and name. An agent shows the option 1 glyph avatar, its name and a 12px "Agent" tag. "Requested by <person>" appears on hover and focus, and is always shown in detail.
- **Status vocabulary,** always icon plus text: Draft, In progress, Waiting on a person, Waiting on a connection, Blocked by a task, Needs review, Paused, Done (verified), Done with exceptions, Failed, Outcome unknown, Cancelled. `success` is only for Done (verified). `warning` covers waiting, blocked and needs review. `danger` covers Failed and Outcome unknown. Draft is neutral, and In progress follows option 1 (`accent`).
- **Filters.** Status, Owner (split into People and Agents), Kind, Project and Store. When filters hide items, a sticky footer reads "4 tasks hidden by filters · Clear filters".
- **Board.** Another view of the same records. Columns are 272px. Done and Cancelled collapse into a narrow rail. Every move is available through a keyboard-reachable "Move to…" menu; dragging is optional.
- **Coordinator suggestions.** A block headed "Coordinator suggests (n)". Each row gives a one-line proposal, its reason and a type tag. The only actions are "Open in Inbox" and "Dismiss suggestion". Affected rows show "Decision pending".
- **Latest update card on the Brief tab.** A health label (On track, At risk or Off track, as text and icon), the author (with an "Agent" tag if it is an agent), the time and the body, then a framed "Since 12 Oct" block of old → new changes and counted progress ("6 of 14 products drafted"). Agent-written claims are tagged Measured or Hypothesis, and measured claims link to Results.
- **Task detail, artifact first.** The centre column is at most about 720px wide, with `reading_px` for the description. Below the 20px title sits a two-column key/value grid with 40px rows: Status, Owner, Requested by, Store, Credits held / ceiling, Due, Depends on, Revision. Do not add a third properties column; the 336px pane keeps the right edge.
- **Outputs.** A card with the name, revision ("Draft r4 by Copywriter · Agent · 12 min ago") and a link to open it in its tab. Older revisions sit behind "Version history". A "Saved" / "Saving…" / "Not saved · Retry" indicator sits by the title.
- **Sub-tasks and dependencies.** A segmented bar labelled "3 of 7 done" (never an estimated percentage), a bounded table, and typed relations ("Depends on", "Blocks"), each with its live status and owner. A blocked item names the next responsible actor.
- **Agent run block.** A "Requested by <person>" card holding the brief, then "Worked for 4m · 7 steps ›" collapsed. Expanding it shows plain-language step lines, and "View technical trace" is one level further down. A strip shows Status, Credits used / held, Run time and Connections used. While running, show elapsed time only.
- **Results.** Accepted outputs and verified effects are listed separately. Evidence cards carry counted verdicts ("8 of 8 checks passed"). Rows for Outcome unknown or an open exception stay pinned, with a Reconcile link. Completion is a durable Activity entry: "Marked done by Aisha · 12 outputs accepted · 1 exception open".
- **Home,** one column of section cards with 24px gaps:
  1. The title, with the workspace, store chip and brief freshness.
  2. A "Start work" composer that hands off to the Coordinator.
  3. "Needs your attention", grouped by Questions, Approvals, Access requests and Exceptions, each with a count and one "Open" that goes to the filtered Inbox.
  4. Active goals, with status-count chips.
  5. Recent verified changes, each linking to its evidence.
  6. Mentions.

  Each panel has its own empty, denied and loading states, so Home never fails as a whole.

**Avoid**
- Decide buttons outside Inbox and Review (hilos "Approve dispatch?", Deel "Pay now").
- Agents that look like people, or agent titles that suggest authority.
- Saturated status fills on rows or groups. Decorative Home dashboards, donuts, carousels and promo banners.
- AI verdicts presented as fact. Percentage progress on running agent work.
- Raw traces as the main view. Toast-only completion. A chat transcript as the only record.
- Spreadsheet density below 14px. Drag-only moves.

## 5. Agent conversations (project conversation pane)

**Informs:** the conversation pane (P14.T01b), the Ask workspace composer, docked questions, proposal, artifact and outcome cards, citations and the Sources view, @mentions, and the waiting and running states.

**References**
- [Cofounder — task-scoped agent thread with question card](https://mobbin.com/screens/52d55c74-ed5e-4f4f-adbf-40715cb4bb66): "Ran 3 actions" collapsed, "Waited for the user's answer", a docked question and a quiet "1 update · Review" pointer.
- [Browserbase — proposal card in chat](https://mobbin.com/screens/85485993-65f8-4381-a419-ce5f8f4662cf): adopt the card anatomy (rationale, change count, diff preview) but not its inline "Update agent" commit button.
- [Tana — mixed person and agent thread](https://mobbin.com/screens/254e49a0-cf54-4a7c-8206-c706a58c6346): inline record mention chips, "Thought for 16 seconds" collapsed, and an embedded record card with a status badge.
- [ChatGPT — group chat with @ChatGPT](https://mobbin.com/screens/fa707eb9-8ecd-48e1-b94d-647c03a08bc6): centred system event lines, a scope notice, and a composer that teaches @-addressing.
- [ChatGPT — deep research run with Activity and Sources](https://mobbin.com/screens/b045e2cd-4f54-424a-97f6-4c5954f0c1e1): a compact run card with Stop, and separate Activity and Sources tabs.
- [Unify — agent pauses to ask](https://mobbin.com/screens/ca1f0060-e1ab-4ba2-98f9-6a9789f2afc4): the strongest question card, naming who it waits on and why, with numbered options, Other, Skip and an n / N pager.
- [Dropbox Dash — per-claim source chips](https://mobbin.com/screens/fc54be30-29ff-430c-9554-7858c47373e8): restrained citations with an "N sources" footer.
- [Replit — editing flow with checkpoints and pause strip](https://mobbin.com/flows/d3355324-0ea5-45af-aeda-ffe4d42a3692): a revision card per checkpoint and a pinned "Paused · waiting for your response" strip.

**Patterns to adopt**
- **Pane header.** Keep the option 1 header ("Project conversation" with the participant stack). Below it, add a compact view switch: Conversation | Activity | Sources. Each label carries a count, and Sources can wait for the evidence contracts. Add a thread title with a chevron when a project has several threads, and a collapse button.
- **Message rows.** A 20 to 32px avatar, a 14px semibold name, an "Agent · Copy specialist" text tag for agents (`subdued` on `canvas`, never `accent` or green) and a 12px `subdued` time. Use 8px between header and body, and 16px between messages. Every author is an `ActorRef` from the server. Until `people.list` exists, follow P14.T01a's opaque labels ("Member · 3f9a").
- **System event lines.** Centred, 12px `subdued`, between hairlines: "Amina added Creative agent", "Coordinator assigned task", "Owner paused all agent runs on this store".
- **Steps.** Below the agent's lead sentence, one collapsed line: "Ran 4 steps · 38s ›". Expanded, it shows one plain line per step ("Read Products tab · 24 items"). The running step shows a small spinner and present tense. A failed step shows a danger icon and the word "Failed". Link to "View in Activity" for the full trace. Never show percentages.
- **Streaming.** Text appends in place. Auto-scroll only if the reader is already at the bottom; otherwise show a "New activity ↓" pill. A polite live region announces milestones ("Draft ready", "Waiting for Amina"), never tokens, and never moves focus.
- **Run strip above the composer.** It extends option 1's running line: "Copy agent is working · step 3" with "Stop run". While a run is active, Send becomes a labelled Stop.
- **Waiting strip.** It always names the blocker and since when: "Waiting for Amina's answer · 6m", "Waiting for approval from an eligible reviewer", "Waiting for Shopify reconnect", "Scheduled · resumes 09:00". Each links to the blocking item. Use `warning` with an icon and text.
- **Question card,** docked above the composer and not modal. It shows "1 of 3", option rows (a 14px title, a 12px `subdued` consequence line and number-key hints) with a neutral "Suggested" tag, an "Other" field, and "Skip" and "Send answer". The same item lives in Inbox, and answering in either place resolves both. Afterwards it collapses to "Answered by Amina · Option 2 · 10:42". Never label the button "Approve".
- **Proposal card** (white, 1px `border`, `radius_px.surface`). Header: "Proposed change · revision 3", with a "Needs approval" warning chip. Scope line: store, object count and credit ceiling ("≤ 40 credits"). Body: before and after for the first three items (old struck through in `subdued`), then "+9 more". Actions: "Open review" (charcoal) and "Request changes". There is no approve control in chat.
- **Superseded or expired card.** The text dims, a note reads "Superseded by revision 4. Earlier approvals no longer apply. Compare revisions", and the actions are removed, not just disabled.
- **Artifact card.** Option 1's linked-output row, with a type icon, title, "Draft · v2 · edited by Copy agent" and "Open in Products tab". Opening it switches the tab and highlights the changed rows for about 2 s with a 120 ms fade. With reduced motion, show a static outline instead.
- **Outcome cards.** "Saved draft revision 3" (success). "Failed · nothing was changed", with "Try again". "Outcome unknown · reconciling with Shopify", in amber with "View in Activity" and no retry. "Published · verified 10:44" appears only after read-back.
- **Citations.** A 12px chip after each sourced claim, giving type and freshness ("Shopify · Linen shirt (synced 2h ago)", "Knowledge · Brand voice v4"). Restricted sources show a lock and "Restricted source" with no content. Unsourced conclusions carry a "Hypothesis" tag.
- **@mentions.** The picker groups People, Agents and Records and is keyboard navigable. A mention renders as an inline chip. Mentioning an agent shows a pre-send hint: "Mentioning Copy agent creates a scoped request on Autumn collection · est. ≤ 40 credits". After sending, a system line confirms "Request sent to Copy agent · Task #214".
- **Composer.** 2 to 6 lines, with a 1px `controlBorder`, `radius_px.control` and a visible `focus` ring. A removable context chip names the attachment ("Products tab · 3 rows selected"), and the referenced rows are highlighted in the artifact. Buttons: attach, @, and Send or Stop. A 12px credit-ceiling caption sits below. The draft persists per task across navigation and reconnects. Each send uses a per-actor `Idempotency-Key`.

**Avoid**
- Approve, Apply or Update buttons in messages.
- A generic "An error occurred · Retry" after partial writes. See [Lightfield](https://mobbin.com/screens/99d01dcd-a6c6-4a51-8e61-b202b1fe08af) for the counter-example.
- Joke loading copy and fake progress bars. Right-aligned coloured bubbles, gradient composers, sparkles and glows.
- Accent or green on agent identity. Raw JSON or prompts in the thread. Modal question overlays. "Auto-answer" for questions owed to a person.
- Focus stealing or per-token announcements while streaming. Dark IDE chrome.

## 6. Decision Inbox and approvals

**Informs:** the Inbox list and detail, the question answer card, the access grant form, exception detail, the Review screen with its decision panel, approve-selected, typed confirmation, stale and expired states, and the Home attention queue.

**References**
- [Linear — Inbox list and detail](https://mobbin.com/screens/beb9d6b3-ec34-46d7-9332-320fcb32a338): opening an item changes only its read styling, never its state, and each row has a reason line.
- [Slite — "Where you're needed" vs "Nice to see"](https://mobbin.com/screens/5da0de72-bedb-4c86-9cc9-905eb129b95d): a count only on items that need you, quoted excerpts, and an end-of-list sentence.
- [Hex — review panel beside the artifact](https://mobbin.com/screens/b6d30984-785d-4ae1-a740-986428e63945): the decision options spell out their consequence, and approval names "this version".
- [Postman — field-level change review](https://mobbin.com/screens/54457cad-1d74-44c5-8d4b-d7a7c027fd14): a source → destination line, a section per object, and row-level +/− marks.
- [Linear — version history diff](https://mobbin.com/screens/6c14e085-9ff5-4e61-9a21-b04f1b0a3433): a prose diff in the accent palette rather than green and red, with a "1 of 3" stepper and a highlight toggle.
- [Toggl Track — approvals with selection bar](https://mobbin.com/screens/15a0cbb1-30e2-44a8-99d6-b927676eb151): decision-state tabs kept apart from read state, a "Pending review from" column, and the count beside the actions.
- [Cloudflare — typed delete confirmation](https://mobbin.com/screens/aa928ac1-4a1d-4b8c-9ccb-be35211cdca8): the calmest typed-confirmation dialog, consequence first, with the token in a mono chip.
- [Mixpanel — accept access request](https://mobbin.com/screens/c136ab61-d97d-49e0-b628-17bae9a7552f): granting is a different form from approving, with the role preset and a risk note.
- Also useful: [AirOps — per-item agent proposals](https://mobbin.com/screens/6642909e-6268-45ee-8028-72f19c646023), which shows a rationale per row (drop its "Accept All"), and [Miro — access requests with expiry](https://mobbin.com/screens/05e59db8-5f5a-4f08-ae23-292fd64fe663).

**Patterns to adopt**
- **Inbox shell.** A list column of about 360px on `surface` with `border` separators, plus a detail pane. The conversation pane stays collapsed here. The detail header has "Open in project". With nothing selected, the detail pane reads "3 items need a decision".
- **Top of the list.** A segmented control, "Needs you (N)" and "Updates", then type filter chips (Approval, Question, Access request, Exception, Assignment, Mention) and an "Unread only" switch. Lifecycle tabs (Needs decision, Waiting on others, Done, Expired) are separate from the read filter.
- **Row.** Line 1 has a type icon, a text type label and the title as verb plus object ("Approve 12 product edits · Autumn collection"). Line 2 gives the store · project · requester (with an "Agent" tag if an agent) · "Expires in 23h". On the right sit the time and a decision badge. Unread shows an 8px `accent` dot and a 600-weight title. The badge never changes on open.
- **Read is not decided.** "Mark all read" announces "12 marked read · no decisions changed". Snooze cannot go past an item's expiry.
- **Distinct forms per type.** Question: an answer card captioned "Answering does not approve any change", with "Send answer". Access request: requester, resource and scope, role preset to least privilege, a risk note, expiry, and "Grant Member access" / "Decline". Exception: known vs uncertain effect, the affected record, and "Reconcile", never "Retry". Approval: opens Review.
- **Review header,** pinned and read-only: workspace › store (shop domain) › project. Then "Revision 3 · proposed by Copy agent on behalf of Maya · 2h ago", "Expires Tue 14:00 (in 23h)" and an eligibility line ("You can decide · Owner"). A workspace filter can never change this target.
- **Rationale.** A "Why this change" block, labelled as the agent's reasoning, with linked sources. It is kept visibly apart from measured store facts.
- **Field diff.** One collapsible section per object ("Linen shirt · 3 of 9 fields changed"), in three columns: Field | Current in store ("read 4 min ago", with Refresh) | Proposed. Variant and price rows get +/− gutter glyphs. Unchanged fields hide behind "Show 6 unchanged". Columns sit side by side at 1120px of content width or more, and stack below that.
- **Prose diff.** Inserted text goes on `accentSurface` with an underline. Removed text is `subdued` with a strikethrough. Use `<ins>`/`<del>` with visually hidden "inserted" and "deleted" text. Add a "Change 1 of N" stepper (previous/next and j/k) and a "Highlight changes" toggle. Keep green and red for status and risk.
- **Decision panel** in the 336px pane slot. Summary first: Store, "8 of 12 selected", the credit ceiling, the spend ceiling, and risk as a text chip on `warningSurface` or `dangerSurface`. Then radios, each with a consequence line: Approve revision 3, Approve selected (8), Request changes, Reject. The charcoal primary repeats the target, count and ceiling: "Approve 8 changes to linen-form · ≤ 40 credits". A footnote reads "Publishing runs after approval and is verified separately."
- **Approve selected.** Checkboxes per object and per variant row. A sticky bar reads "8 of 12 selected · Approve selected · Reject · Clear". Selection persists across filters and pages, with a note such as "3 selected items hidden by current filter". Changing the selection clears any typed confirmation. There is no list-level "Approve all".
- **Typed confirmation.** Used for high-risk actions and the solo-owner self-approval rule, which also carries a cool-down. A 480px white dialog with a labelled title opens with a consequence sentence, then "Type linen-form to confirm" with the token in a `utility` chip. The button stays disabled until the text matches exactly. Focus is trapped and returns to the opener.
- **Stale and expired.** If the revision changes while the review is open: "Proposal changed: revision 3 → 4. Your selection and confirmation were cleared." with "Compare revisions". Approve stays disabled until the new diff is viewed. Expired: "Expired 2h ago", with "Ask <agent> to re-propose".
- **After deciding.** The item moves to Done with a durable line: "Approved revision 3 · 8 of 12 items · queued for gateway · 10:42". Only declines get a 5 s undo toast. Nothing claims success before verification.

**Avoid**
- Counting unread items as the Inbox count. Treating "opened" as decided.
- List-level "Approve all" (Deel) or an unscoped "Accept All". A bare "Approve" with no store, count and ceiling.
- Code-style line diffs for product data. Full green/red diff backgrounds.
- Approval and publication in one dialog. Popover-only decision lists.
- Red-header or blurred modals. Typed confirmation on every approval. Hidden OAuth scopes. Snooze past expiry. Accent on approve buttons that implies agent endorsement.

## 7. Onboarding, account and the Shopify connection

**Informs:** the signed-out entry, the account landing (`AccountLanding`, `WorkspaceChooser`, `CreateOrganizationForm`), the invitations section, the switcher, the Home setup card, Settings › Connections › Shopify in every state, the connector return, and the session `StateView`s.

**References**
- [Linear — sign-in entry](https://mobbin.com/screens/c909ca88-6314-4377-8240-2060fd1973ea): a centred mark, one heading, one primary button and a muted legal line.
- [Linear — create a new workspace](https://mobbin.com/screens/5c68cc35-0d93-47ba-b27e-ed4efe90b75c): a card with labelled fields and inline errors, and "Logged in as…" plus Log out kept visible.
- [Hex — choose your workspace](https://mobbin.com/screens/65d8d999-28f4-4f14-bd00-e25852008893): rows with role and member info, a secondary create card, and a recovery line.
- [Notion — join or create](https://mobbin.com/screens/89ff35d8-d58d-4ea6-8afa-4c1832d36ef9): pending invitations naming the inviter, kept apart from creating.
- [Shopify — install app consent](https://mobbin.com/screens/8357695e-1ffd-4ecd-a9cc-d94ccdf29412): the screen the OAuth handoff lands on. Mirror its scope-group wording before the handoff.
- [Linear — integration detail (Slack)](https://mobbin.com/screens/e64c901c-4ada-4f0a-b3a0-89a6ccf490da): the template for a connected store page: header, metadata strip, connections list with a status menu.
- [Intercom — Not connected with Reconnect](https://mobbin.com/screens/f1042da5-05c3-4ca2-86b0-b61edcd09b0b): the broken state stays inline with its recovery action. Healthy state: [6b598b5b](https://mobbin.com/screens/6b598b5b-a36e-42d7-9397-35081ec2ec0f).
- [Hex — workspace setup checklist](https://mobbin.com/screens/eccd070c-1ad6-4248-898e-0f6867407a3e): a calm "2 of 4 complete" setup card on Home.

**Patterns to adopt**
- **Signed-out entry at `/`.** A `canvas` page with a centred column at most 360px wide: the Morrow mark, the heading "Sign in to Morrow" and one line saying the person continues to the sign-in provider and comes back. One full-width charcoal button. No email, password or social buttons, because WorkOS hosts them. In flight, the button reads "Starting sign-in…" with `aria-disabled`. Failures show in a status region under the button, not a toast. Until login body v2, use the packet's "Open the workspace link you were given" state.
- **Account landing.** One `surface` card, at most 560px, with no app sidebar. Sections in order: Invitations (only when present), Your workspaces, then Create your organization (only when `onboarding` says the person is eligible). The footer shows the identity and "Sign out".
- **Workspace row.** A 32px initials avatar, the name at 14/600, and a 12px line with organization · role · store ("No store linked"). The whole row is one link with a chevron. Up and Down arrows move between rows. Add a filter field above about 8 rows. Show "Showing the first 100" when the list is truncated. A recovery line follows the list.
- **Create organization.** Two labelled fields, Organization name and Workspace name, each with helper text, labels above and errors below, and a "Create organization" button. An ineligible person with no invitations sees the explanation state with no button, which keeps no data separate from no permission. Field values survive every failure.
- **Submission states.** "Creating…" with the button disabled. On `uncertain`, show the packet's `OutcomeNotice`, whose only action is "Check again": it resends the same `Idempotency-Key` and never starts a fresh create. On 429, show "Try again in N minutes" and keep the button disabled.
- **Home setup card.** Titled "Set up Linen & Form", with "1 of 4 done" as plain text. A step list with status icons (done, to do, or locked with "Not available yet") sits beside the selected step's description and its one action. Steps: Connect your Shopify store, Invite your team, Choose a plan ("Paid work needs an active plan"), Start your first project. Completion comes only from server state. The card can be dismissed and stays reachable from Settings.
- **Connections › Shopify, not linked.** The purpose line, then "Morrow will be able to:" with the scope groups in Shopify's own words, read-only. A "Store domain" field with a `.myshopify.com` suffix, and "Continue to Shopify" with the helper "You'll approve access in Shopify Admin, then return here." People who are not eligible see "Ask an admin to connect your store".
- **Return from Shopify.** It lands on the same page and announces the result. The row reads "Checking link…" (neutral), then "Connected" (success dot and text). If the link cannot be confirmed: "We couldn't confirm the link yet", with "Check status". It never says Connected early and never re-runs the install. A cancel returns to "Not connected", with nothing changed.
- **Connected store.** A metadata strip ("Linked by Maya Chen · 6 Oct 2026 · Last sync 3 min ago"), a store row with a status menu (Reconnect, Disconnect) and granted access as a read-only list.
- **Needs reconnect.** The row stays listed, with a `warning` "Needs reconnect" tag (icon and text), a one-line reason and an inline Reconnect button. The sidebar status row and any dependent work ("Waiting for Shopify reconnect") change with it.
- **Account `StateView`s** use the same centred card: "Your session ended" with "Sign in again"; `WorkspaceUnavailable` ("This workspace isn't available to you", with a link to `/` and no sign-in loop); signed out; and a sign-out with an unknown outcome ("Try again").

**Avoid**
- Gradient or illustrated auth screens. Social or SSO button grids on Morrow's page.
- Email-domain auto-join and shareable invite links. A forced invite step in signup. Persona questionnaires.
- Percentage rings and gamified checklists. Trial countdowns (there is no free tier).
- A toast-only "connected". Editable per-scope toggles for Shopify. Thumbnail-grid workspace pickers. Welcome videos or tours.

## 8. Agents and Agent Store

**Informs:** the Agents installed list (with a Platform section for the Coordinator), agent detail (Overview, Access, Connections, Knowledge, Routines, Activity, Usage), the Agent Store catalogue and listing, the install review flow, the post-install sample and activation, the builder entry and draft workspace, and the stop controls.

**References**
- [Stripe — installing an app (flow)](https://mobbin.com/flows/5d3a2898-f709-4bb3-8a86-c2f25584b3a4): per-resource access rows with Read-only or Modify labels, and a pinned "Installing in live mode" line beside Install.
- [Claude — Connectors with tool permissions](https://mobbin.com/screens/2eb6c9a1-64f2-46a8-9cf8-ba9b1897ba86): tools grouped by effect class with counts, and a per-tool permission state. The model for the Access tab.
- [LangChain Fleet — integrations with Missing scopes](https://mobbin.com/screens/c3ee2df7-4268-4daa-a45d-194770781ec6): readiness labels (Connected, Missing scopes, Connect) in a calm agent shell.
- [GitBook — integration detail with permissions rail](https://mobbin.com/screens/431254e3-9be9-4945-8e49-6eb1eb8f42c1): publisher, maintained badge and "Permissions to" are all in view before Install.
- [Graphite — GitHub App install scope](https://mobbin.com/screens/64e3b175-a140-4b5e-8c00-fffac0e117ac): "All" vs "Only select" radios with consequence notes, permission sentences with bold verbs, and a "Next:" line.
- [Confluence — install flow (flow)](https://mobbin.com/flows/ad5d4edf-c1a6-4a58-89d2-fb53d6f91dd9): two-step full-page review (choose target, review and install) with a separate data-handling section.
- [Lindy — My Agents table](https://mobbin.com/screens/145a1001-d4c0-405c-9779-9454b94ed498): the density baseline for the installed list. Replace its bare toggle with a text status.
- [Notion — custom agent builder entry](https://mobbin.com/screens/7447d652-5d5f-4d9c-b65c-fb566116c362): one question, one prompt field, "Create blank" and four outcome templates.
- Also useful: [Gumloop — agent configuration sections](https://mobbin.com/screens/8296046e-6e5c-42a0-9561-dd60ad9f07cc) for builder section order. Avoid its self-editing switches.

**Patterns to adopt**
- **Agents destination.** A segmented control switches between Installed, Agent Store and Drafts. Always write "Agent Store" in full, with a grid icon and never a shopping bag, so it cannot be confused with the merchant's store.
- **Platform section.** The Coordinator is pinned in a "Platform" section labelled "Coordinator · Morrow platform", and it cannot be uninstalled. Chief of Staff, CMO and other roles appear under "Installed roles". No title is styled as a rank.
- **Catalogue.** A category rail of about 200px, grouped by outcome, beside a card grid: 3 columns at 1120px of content width or more, 2 at 768px, 1 at 390px, with 16px gaps. Each card shows, in order: the mark, the name, the publisher (with a bordered "Maintained by Morrow" text badge when first-party), a one-line outcome, required connections, the expected credit range ("About 40 to 120 credits per run") and "View details". Never put Install on a card.
- **Readiness labels,** text plus icon: Connected (`success`), Missing scope (`warning`), Not connected (`subdued`), each with its eligible action (Connect, Grant scope, Reconnect).
- **Listing detail.** The header has the mark, name, publisher and release ("v1.4 · released 12 Oct") and a charcoal "Review and install". Tabs: Overview, Capabilities, Permissions and data, Sample work, Release notes. A right rail of about 280px shows Publisher, Release, Works with, Permissions summary, Expected usage, Compatibility and Links. The rail moves below the body under 1120px.
- **Capabilities** as effect sentences in three groups: Reads, Drafts (kept in Morrow), and Proposes for your approval. Each row has a right-aligned access label: Read-only, Draft or Needs approval.
- **Install review,** a two-step full page. Step 1, Choose scope: "Only selected stores" (the default) vs "All linked stores (includes stores linked later)", the connections, and a monthly credit ceiling. Step 2, Review access: accordion rows per resource with plain explanations, a separate "Data handling" section, and "People who can use this agent".
- **Install footer,** pinned and reachable at 390px. It holds Back, the target line ("Installing into Linen & Form · linen-form.myshopify.com · ceiling 2,000 credits/month") and "Install agent". Under it: "Next: the agent stays inactive until you run a sample and activate it."
- **After install,** the status reads "Installed · not active", with one next step: "Run a sample (at most 50 credits)". The sample is a draft artifact. "Activate" is a separate eligible action shown only after a sample exists.
- **Installed table.** 44px rows. Columns: agent (with an "Agent" tag), status as text and icon (Active, Paused, Not active, Needs reconnection, Stopped), installed by, scope chips, last run, credits this month, and an overflow menu. There is no bare on/off toggle.
- **Access tab.** Tools are grouped by effect class with counts. Each row shows the effective result and "Limited by:", naming the narrowest layer (your role, the installation grant, connector scope, workspace policy, or the installer's current access). The results are read-only. A change is requested with "Request access change", which creates an Inbox item; it is never applied directly.
- **Narrowing.** When a grant or scope shrinks, show an inline warning on the Access rows and on pending work ("write_products was removed on 18 Oct; 3 proposals are paused"). Never remove actions silently.
- **Stop controls.** "Pause agent" is a secondary button. "Disable agent" (`agents.installation.disable`) is a human-only kill switch. Its dialog needs a reason, states which future work stops and which completed or submitted effects remain, and takes one eligible human's confirmation with no second approver. An agent-proposed stop arrives as an Inbox item.
- **Builder entry,** a dialog titled "What should this agent do?" with one prompt field, a "Start blank" link and four outcome templates. Templates fill a draft and never activate it.
- **Builder workspace.** The draft configuration is the central artifact, in stacked sections: Purpose, Skills, Knowledge, Connections, Outputs, Triggers and routines, Authority and limits, Sample results. Each section shows a status line ("Missing: brand voice guide") and its own "+ Add". The builder conversation sits in the 336px pane and asks structured question cards (as in section 5). Permissions are requested only in "Authority and limits".
- **Builder footer.** "Save draft", "Run sample" (with its ceiling) and "Request activation". The last is disabled with a reason for people who are not eligible. "Draft · revision 4 · saved 2 min ago" is always visible.

**Avoid**
- One-click Install on cards. A bare enable toggle. Broad scope by default. "Always allow" as the default for tools with external effects.
- Agent self-expansion switches. Flat lists of more than 15 permissions. Marketing heroes. Star ratings as the main trust signal.
- Model or provider pickers. Consent hidden in fine print. "Store" or a shopping-bag icon for the catalogue. A "Successfully installed" modal that implies the agent is ready to act.

## 9. Settings, members, billing and usage

**Informs:** the Settings shell, Members and Invitations, the role-change and ownership requests, the read-only Roles comparison, Usage, Limits and alerts, Plan and billing on both routes, the unpaid state, Connections and connection detail, and the Audit log.

**References**
- [Vercel — Members with inline invite and role menu](https://mobbin.com/screens/ef2f4dd6-54a5-4a53-b954-2a59e9f9e8e2): each role option has an effect line, disabled options keep their reason, and Members and Invitations are tabs.
- [Linear — Members with an Application row](https://mobbin.com/screens/ae99a607-158a-4642-a69f-00c024381bd0): a dense, quiet table where a non-human member carries its own kind label.
- [Vanta — Roles permission details](https://mobbin.com/screens/6dd83a18-ede6-44a5-adc5-2ebff239c7de): a read-only matrix with icon-plus-text cells. This fits ADR-0017's frozen grant templates.
- [OpenAI Platform — usage with budget rail](https://mobbin.com/screens/2bf4f941-a9a7-4308-aa0c-864135823830): a single-accent chart and a period meter with alert ticks, "Resets in" and breakdown tabs.
- [OpenAI Platform — project limits and alerts](https://mobbin.com/screens/8cf8d3eb-515b-4ff9-b14c-dddcfb207adf): the limit, its meter and its alert rows in one panel.
- [Obvious — billing, credits and history](https://mobbin.com/screens/331ff15c-a8b4-4ce4-adc2-29b4b1ab33f3): a plan card, a Payment | Credits row, and one credit-and-billing ledger.
- [GitHub — installed app permissions and danger zone](https://mobbin.com/screens/9c201481-8659-4ae5-be81-b1a6ccc4eda7): a plain scope list, explicit resource coverage, and destructive rows that state their consequence.
- [PlanetScale — audit log](https://mobbin.com/screens/8af442b9-2a21-43a6-a2b5-5b2ff3fbc79d): each row leads with a plain sentence and puts a mono event-key chip second.
- Also useful: [Vercel — usage breakdown](https://mobbin.com/screens/fd0e54a5-45cc-4a47-be0d-3fdb7e804ec7), [Customer.io — connections table](https://mobbin.com/screens/e95bd92b-7d41-4dff-aa5d-3eef55514906), and [Attio — members with Resend and Revoke](https://mobbin.com/screens/4f090dd4-deb6-4eae-b0ed-6a9c653594c0) (rate limit: [7ecd0028](https://mobbin.com/screens/7ecd0028-b635-4cf6-88df-b619340d8a83); revoke dialog: [2a6947a5](https://mobbin.com/screens/2a6947a5-4c3d-4210-b24f-f919efcd1dca)).

**Patterns to adopt**
- **Settings shell.** Keep the main 232px sidebar, so the Inbox count and the store status stay visible. Add a 200px secondary nav grouped as Workspace (General, Members, Roles), Stores and connections, Spending (Usage, Limits and alerts, Plan and billing) and Governance (Audit log, Notifications). Below 760px it becomes a labelled select. There is no conversation pane on settings pages.
- **Page anatomy.** A 12px `subdued` breadcrumb, a 28px title and a one-line purpose. Then `surface` sections with 24px gaps, each with its title on the left and its actions on the right. Forms are at most about 880px wide. Only a bounded table region may scroll sideways.
- **Members.** Columns: Person, Role ("Admin · v1"), Status ("Active", "Invited · expires 26 Oct", "Invitation expired", "Role change in review"), Last active and an overflow menu. Header: search, Role and Status filters, and a charcoal "Invite people". Members (n) and Invitations (n) are tabs. The owner row shows "Owner" with no inline control.
- **Invite panel,** inline. An email chip input and a role select with only the two invitation templates, each with an effect line ("Member: works on goals, tasks and questions"; "Admin: also manages people, connections and approvals"). A role the actor cannot grant is disabled with "You can only grant access you hold". The footer says invitations expire and that Morrow access grants no Shopify admin access. The button is "Send invitations (3)". Invitations that need review show "Pending review".
- **Role change.** A request, never a live dropdown. "Change role…" opens current vs proposed side by side, with gained and lost capabilities (+/− plus text) and the button "Request role change". This creates an Inbox access item, and the row shows "Role change in review". "Transfer ownership…" follows the same pattern.
- **Removing a member** (`governance.membership.revoke`) is a human-only kill switch. Its dialog needs a reason, lists the affected workspaces and takes one confirmation. Removing the last owner is disabled with a reason.
- **Roles page.** A read-only comparison: columns are the templates, rows are grouped by area, and each cell is icon plus text ("Can administer", "Can do", "Can view", "No access"). An Overview tab gives one sentence per template. No checkboxes, Add role or Save.
- **Agents beside people.** Members has a Kind filter, or an "Agents acting in this workspace" section. Agent rows show "Installed by Dana", the line "Acts within the requester's and installer's access" and "Manage in Agents". They never get a role select.
- **Usage header.** Three figures: Available credits (28px), Reserved by running work (linking to the running tasks) and Used this period (settled), with "Period resets 1 Nov". Below them sits a meter against the workspace limit, with labelled ticks at each alert threshold and "Edit limit".
- **Usage breakdown.** A bar chart in `accent` only, with Daily and Weekly views, a Cumulative option and period presets. A tabbed table follows: By project, By agent, By person, By store. Its footer reads "Settled usage as of 10:42. Running work shows as reserved until it settles." Add "Export CSV". Load the `dataviz` skill before building the chart.
- **Limits and alerts.** The limit panel states its effect: "When reached, new paid work waits and an Inbox item is raised; running work stays within its reservation." Alert rows read "80% of limit · Admins · Inbox and email". The edit dialog shows used, reserved and the trailing average, and warns when the new value is below reserved. The button is "Save limit". People who are not eligible see who can change the limit.
- **Plan and billing, Morrow-direct route (ADR-0015).** A Plan card (status as icon and text, price, renewal) with "Change plan" and "Manage billing ↗". A Payment method | Credits row. A ledger with Date, Description, Credits ±, Amount and Status. A purchase reads "Pending payment" until confirmed, never "Granted" early.
- **Plan and billing, Shopify route** (or any workspace that has ever linked a store before paying). A "Billed through Shopify" panel with the shop, plan and "Manage in Shopify admin ↗". No Morrow checkout, plan change or buy-credits control appears anywhere. Usage and Limits still show.
- **Unpaid workspace.** A persistent `warning` banner: "Paid work is off. You can set up the workspace and invite people; agents can't run paid work until a plan is active." Billing-eligible people get "Choose a plan"; others get "Ask an owner".
- **Connections.** A Shopify store panel (identity, linked by and when, health, last sync, plain-language access, "View details") above a Services table. Reconnect is the visible action when needed, and Disconnect lives in the overflow menu. Adding a service happens in its own tab.
- **Connection detail.** Sections: Access granted, Covers, Health, Used by. Disconnect (`governance.connection.disconnect`) is a human-only kill switch. It asks for a reason and states the consequence: "Agents lose access now. 3 pending approvals for this store will no longer apply. Changes already made in Shopify stay." The button reads "Disconnect linen-form.myshopify.com". The result is announced and recorded in the Audit log.
- **Audit log.** Filters: Actor (People, Agents, System), Event type, Store and Date range. "Updated 10:42 · Refresh", with no auto-scroll. Each row has an actor chip (an agent shows "for Dana"), a plain sentence with a linked target, a 12px `utility` event-key chip, a store chip and an absolute time with the timezone.
- **Event drawer** (400px, light). Sections: When (local and UTC), Who (actor, on behalf of, via installation), What (before → after), Authority (approval reference and revision) and Outcome (Confirmed, Failed, or Unknown: reconciling). The raw payload sits under "Technical details". Focus returns to the row on close.

**Avoid**
- Role dropdowns that apply instantly. Editable permission matrices.
- Multi-colour usage charts. Buy, upgrade or trial prompts in the chrome, or on any Shopify-route workspace.
- Marketing banners in settings. A card grid used to manage live connections. Raw JSON as the main audit view. Dark drawers.
- "Granted" or a success toast before confirmation. Status shown by colour alone.
- Auto-reload top-ups, which would need an owner ADR (P18). Toast-only confirmation of consequential changes. A settings-only sidebar that hides Inbox and store status.

## 10. Cross-cutting rules

**Density**
- List rows are at least 40px, installed-agent rows 44px, and sidebar rows 32px. Body text is always 14px, even in dense tables; text never shrinks to fit columns.
- Review and Brief are more spacious than lists. Long text uses `reading_px` at about 720px measure.
- Only bounded tables scroll sideways (`table-scroll`). The page never does, down to 320px.

**Typography hierarchy**
- Page and project title: `title_px` 28 at weight 600. Section and task title: `section_px` 20 at 600. Card and sub-section heads: 16 at 600.
- Body is 14 at 400, with 500 for names and 600 for unread titles. Captions, times and tags are 12 in `subdued`.
- `utility` mono only for IDs, event keys, revision hashes and typed-confirmation tokens.
- Line height is 1.5. Use one weight scale (400, 500, 600) and no display or marketing type.

**States** (each is a `StateView` variant or an inline pattern, with copy in `copy.ts`)
- **Empty vs denied.** "No work yet. Ask the Coordinator to start one" is different from "You don't have access to view work", which names who can grant it. Never merge the two.
- **Loading.** Skeletons at their final dimensions. No spinner in place of the layout, and no invented percentages.
- **Not in this build.** P14.T01a's `not_in_build`: a truthful dependency state, with no request made.
- **Running.** Name the actor and the current step ("Copy agent is working · step 3"), show elapsed time, and always offer Stop.
- **Waiting.** Name the blocker (a person, an approval, a connection or a schedule), say since when, and link to it.
- **Stale or incomplete.** Show the source and time ("synced 2h ago"), with Refresh. Limit the conclusions drawn and the actions offered.
- **Partial.** List the outcome of each item, and keep unresolved items pinned.
- **Failure vs unknown.** A confirmed failure says nothing changed and offers Try again. An unknown outcome gets a persistent `OutcomeNotice` whose only path is reconciliation; there is no fresh retry.
- **Conflict or expired.** Show both versions, or the new comparison. Clear the old selection and confirmation.
- **Paused or cancelled.** State which future work stopped and which submitted or completed effects remain.
- **Restricted or disconnected.** Name the boundary and give one eligible recovery action.

**Accessibility** (WCAG 2.2 AA is the target, not a conformance claim)
- **Semantics.** Native buttons and links. Tabs use `tablist` with arrow keys. Menus use roving focus. Disclosures use `aria-expanded`. Dialogs and drawers trap focus, make the background inert, close on Esc and return focus to the opener.
- **Focus.** A visible 2px `focus` ring on every interactive element. Editable controls use `controlBorder`, never `border`.
- **Status.** Every status is icon plus text. Diffs use `<ins>`/`<del>` with hidden text. Counts have accessible names ("Inbox, 3 decisions pending").
- **Live updates.** One polite `StatusRegion` for confirmations and milestones. Never announce per token, and never move focus while streaming.
- **Input and motion.** Every drag has a menu or keyboard alternative. Follow WCAG target-size rules. Motion is 120 ms, and non-essential motion is disabled under reduced motion.
- **Test journeys.** Approve an image without a pointer, read a diff with a screen reader, recover from form errors, and navigate while an agent streams.

**Narrow layouts**
- **Content width under 1120px.** The pane collapses to a header toggle with a new-message count and opens as a 336px sheet with a scrim. Focus moves in, and Esc restores it to the toggle.
- **Viewport under 760px.** The sidebar becomes a left modal drawer with the same content and order, opened by a labelled "Menu" button. The workspace switcher becomes a bottom sheet.
- **Phone (390px, reflow at 320).** The top bar holds back, a title that wraps and overflow. A segmented control switches Artifact, Conversation and Activity. Artifact tabs become a horizontally scrolling row, and properties wrap as chips.
- **Primary action on phones.** It moves to a sticky bottom bar that repeats the store and the selected count. Drafts, composer text and selection persist across every switch.
- **Review at narrow widths.** The body scrolls, and the footer with target, count, ceiling and action stays reachable.

## 11. Next UI packets this informs

- **P14.T01a PR-2** (account and work wiring):
  - The account landing, chooser and create-organization form, and the switcher (sections 3 and 7).
  - Home with per-panel states, and the setup card only where real server state exists (sections 4 and 7).
  - The Work goals list with per-goal task disclosure (section 4).
  - Task detail with the Brief and Questions tabs.
  - The Inbox question list and the question answer form (section 6), and the `OutcomeNotice`.
  - Constraints: opaque person labels, no "You", and `not_in_build` panes.
- **P14.T01b** (conversation pane): section 5, plus the pane mechanics in section 3 (container-query collapse, toggle count, overlay sheet, phone switch). It is built on the accepted P01.T02c types.
- **P07.T03a** (collaboration): @mentions that create scoped requests, comments anchored to rows and passages with the artifact highlighted, assignments and system event lines, and durable notifications in the Inbox "Updates" view (sections 5 and 6).
- **P11 decision UI** (the P14.T03a slice in M4, with P11.T01a–T03a and P11.T05a): the Review header, field and prose diffs, the decision panel, approve selected, typed confirmation and the solo-owner cool-down, stale and expired states, outcome cards (verified, failed, unknown), and the kill-switch dialogs (sections 6, 8 and 9).
- **P16 Agent Store** (P16.T01–T05): section 8. That covers the catalogue and listing (T01), the builder (T02), sample and separate activation (T03), update, disable and uninstall as kill switches (T04), and the complete journeys at desktop and narrow widths (T05).
- **Later, from the same guide:** the P05.T01z people route (section 9 Members and Invitations), the P09 connector link and return (section 7), and billing (P01.T04a, then P18; section 9).

## 12. Mobbin usage notice

All seven sweeps returned the same notice. It is reproduced verbatim below.

---

**Your Mobbin AI usage is high this month**

Usage is unlimited during beta. If your usage stays at this level, you may need to purchase more credits once limits take effect. [View usage and plan options](https://mobbin.com/settings/billing-and-usage)
