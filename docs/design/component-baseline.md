# Option 1 component baseline — candidate
Canonical sequence 24; P02.T02. Codex self-review, 6 October 2026. Merchant/reviewer baseline approval pending P02.T04. tokens.json is the machine-readable palette, spacing, typography and width reference; the selected image is docs/references/visual-option-1.png. Supporting UI Page sequence 8 is subordinate to the canonical standalone/thin-connector scope.

One calm, light workspace: pale navigation, white work surface, charcoal primary actions, restrained purple selection, system typography, modest borders and compact project tabs. Project artifacts occupy the central space; conversation is contextual and decisions remain accessible from Inbox. Text labels communicate status in addition to color. No decorative gradients or marketing typography in operational screens.

| Component | Required behavior |
| --- | --- |
| Navigation and store switcher | Seven destinations; current location named; store filter is separate from the pinned operation target. At narrow width a labelled drawer traps focus, makes background inert and restores focus on close. |
| Project heading and artifact tabs | Work title, store, draft/live status and people/agents; Brief, Products, Creative, Results. Native buttons with tab semantics, arrow keys and selected focus. |
| Artifact editor | Labelled fields, revision/freshness, attributable draft state; save errors preserve edits, conflict shows both versions. Navigation requires stay/save/discard. |
| Conversation | Contextual messages, tool/evidence result summaries, questions, stop controls and estimated credit ceiling; collapsed pane has a reachable selector. Draft sharing and ordinary answers never imply permission to publish. |
| Review dialog | Pinned account/store, exact selected items, before/after, revision, permission, credit ceiling and consequential action. Explicit confirmation; item changes clear it; stale or uncertain work cannot reuse it. Scrollable body and reachable footer at small widths. |
| Cards and tables | Labelled item/status/actions; readable empty and partial states, keyboard selection. Only a bounded table may scroll horizontally; no whole-page horizontal scroll at 320 CSS pixels. |
| Feedback | Inline errors for correction, status region for confirmation, persistent unknown-outcome notice with reconciliation; no success wording before verification. |
| Thin connector | Installation/link/status/reconnect/disconnect/return controls only. Separate fixture surface; applicable native Shopify controls and distribution remain P09/external qualification. |

Content widths: reference frames 1440, 768 and 390 pixels; check reflow at 320. Sidebar 232; conversation 336. Pane collapse is based on available workspace content width below 1120; navigation below 760 viewport width. Pane controls remain functionally reachable. Controls use visible focus and the darker control border; light separators do not identify an editable control. Motion lasts 120 ms and nonessential motion disables for reduced-motion preference. Minimum ordinary text target contrast 4.5:1, focus/control target 3:1 against their specified background. WCAG 2.2 is the accessibility design target, not a conformance claim: https://www.w3.org/TR/WCAG22/.

Second-pass critique repaired a mismatched pane/header grid, disappearing mobile team icon, background focus in the drawer and partial approval scope. Review text is intentionally more spacious than dense lists. Draft-only illustration choices do not pretend to be real product photographs. Actual screen-reader announcements, user comprehension and 90% unassisted task success require the participant protocol. The prototype is a design artifact; it is not the production feature tree.

P14.T01a ports this baseline into `packages/workspace-ui` (tokens generated from tokens.json by `npm run ui:tokens`; no colour literal outside `tokens.css`) as a provisional, labelled build; P02.T04 still qualifies it.
