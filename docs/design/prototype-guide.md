# Stateful prototype and journey map

**Option 1 prototype (ADR-0032, 2026-10-23).** `prototype.html` shows Visual option 1, which ADR-0032 replaced with Sunrise. Its journeys and states still describe behaviour to keep; T7 (`docs/plan/mvp.md`) replaces it with a Sunrise prototype and its own browser receipt. Since T7 PR 14 the workspace port itself is Sunrise (`docs/design/sunrise.md`); `browser-checks.json` remains this prototype's receipt.

Open docs/design/prototype.html in a browser, or serve docs/design locally. Sample Linen & Form data only. Role and Scenario selectors are test controls. No store actions, AI runs, actual messages, subscription purchases, OAuth or authority enforcement occur. Mock saved briefs use local browser storage; unsaved offline text survives only in the currently open page, not a reload or another device.

| Journey | Path to exercise | Observable result |
| --- | --- | --- |
| Onboard | Scenario: onboarding | Connection, team and initial work setup remain separate; no paid activation. |
| Project | Work → Brief / Products / Creative / Results | Artifact deep link survives reload; Main store target stays pinned if navigation filter changes to Outlet. |
| Protect edits | Change Launch instructions then navigate or switch store | Stay retains text; save/discard explicit; failed save retains dirty state. |
| Review | Products → review, select two items and confirm | Two-item scope and 20-credit ceiling; unselected tote remains draft; confirmation clears when scope changes. |
| Specialist | Role SEO analyst → review | Approval denied with eligible reviewer route. |
| Stale / conflict | Scenario stale or conflict | Refresh requires new confirmation; local and remote versions shown separately. |
| Questions | Scenario question → answer | Answer does not approve publication. |
| Recovery | Session / revoked / disconnected | Private sample details hidden until mock recovery; connector offers only connection controls and return. |
| Uncertain / cancelled | Scenario uncertain or cancelled | New approval blocked pending reconciliation; no blind retry. |
| Partial | Scenario partial | Per-item results distinguish verified, failed and unresolved work. |
| Builder | Agents → create draft | Purpose, required account and reviewer collected; save does not install or activate. |
| Agent Store | Agents → Agent Store | Examples are not qualified published releases. |
| Creative | Creative → select image with keyboard → review | Fidelity review, draft-only; no image model called. |
| Exhaustion | Scenario exhausted | New paid send disabled; ordinary review/export/recovery remains accessible. |
| Responsive | Narrow width → navigation and conversation selectors | Reachable collapsed contents, contained drawer focus, review store/scope/ceiling visible. |

18 scenarios: ready, onboarding, session, revoked, save-error, question, stale, conflict, offline, uncertain, partial, denied, disconnected, exhausted, cancelled, empty, loading, running. Empty/loading/running show truthful mock states. Route catalogue contains 26 logical routes; the prototype illustrates journeys rather than implementing every production screen or data endpoint. Browser-checks receipt covers 54 unique automated local cases at 1440/768/390/320 pixels. Native screen-reader and representative merchant testing have not run.
