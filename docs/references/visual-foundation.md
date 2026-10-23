This document defines the experience foundation for a complete workspace where people and AI agents run a Shopify business together. It translates the [main architecture](https://chatgpt.com/space/page_b399216c68208191a8cecc00a0287e54) and [agent and skill architecture](https://chatgpt.com/space/page_c222d561201c81918c285c22c52a26a4) into a consistent interface, screen contracts, interaction rules, and validation gates.

Build sequence and acceptance evidence: [Shopify Workspace End to End Build and Test Plan](https://chatgpt.com/space/page_b1ef27b80b788191b91e67cbb52f1037).

The product scope remains broad. A focused interface should make the full system understandable through relevant context and progressive disclosure. It should not achieve simplicity by removing entire business functions.

Decision on 6 October 2026: visual option 1 guides one complete Dock-inspired workspace, available both inside Shopify Admin and standalone. Both modes render the same feature screens and workflows, share work records, agents, connections, and permissions, and adapt their layout to available width. Small host adapters handle authentication, navigation, and native controls. Work resumes at package 1 contracts and dependencies in the existing 18-package plan; package 2 develops option 1 into the reviewed interaction baseline for both modes.

Decision on 23 October 2026 ([ADR-0032](../decisions/adr/ADR-0032-sunrise-visual-direction.md)): Sunrise replaces visual option 1 as the look of the workspace. Sunrise keeps option 1's layout (sidebar, project tabs, contextual conversation, Inbox) in a warm, Shopify-admin-like style with friendly agent characters, written in plain words for non-technical shop owners; the embedded home in the Shopify admin follows the admin's own look. Where this document calls option 1 the visual direction or baseline, read Sunrise. Its information architecture, screen contracts, interaction rules, states and accessibility targets stay. The option 1 images below are kept as history.

## Product direction

The experience should let a merchant give the workspace an objective, understand who is doing the work, contribute when needed, and verify what happened. Conversation is an entry point into this system. Tasks, decisions, artifacts, and business changes must remain understandable outside the conversation that created them.

The interface should answer five questions without requiring merchants to interpret technical traces: What needs my attention? What is happening? Who owns it? What can change in my business? What evidence shows the result?

People and agents should appear in the same assignment and activity model, with clear identity labels. Human actions and agent actions remain distinguishable. An agent’s title communicates its specialty; it must not imply authority the workspace has not granted.

Dock's workspace is the reference for the next design exploration, following the owner's direction on 6 October 2026. The initial studies mainly used Shopify Admin composition and Dock's public homepage restraint. The revised brief uses Dock's documented shared work surfaces and contextual collaboration, while retaining familiar Shopify resource controls. Public help illustrations and documentation were inspected; this is not an authenticated product audit. [Dock workspace tabs](https://trydock.ai/help/workspace-tabs)

A possible acquisition is a business aspiration, not a design acceptance criterion. Native integration, product quality, and merchant value are useful goals on their own; this document makes no acquisition prediction.

## Platform surface and shared architecture

Use one shared React workspace in Shopify's developer-hosted App Home iframe and on our own web origin. The iframe model supports complex web applications and public distribution; the Shopify-hosted App Home UI extension model has different distribution and runtime constraints. Shared features include projects, conversations, artifacts, reviews, agent management, connections, and settings. Use the same logical routes and records, with host-specific entry and URL mapping. [Shopify App Home](https://shopify.dev/docs/apps/build/app-home)

Keep thin host adapters around navigation, authentication entry, resource selection, save protection, and short notifications. Shared screens depend on these contracts rather than importing Shopify host APIs. The standalone adapter supplies application-owned behavior; the Shopify Admin adapter uses supported host capabilities. Both call the same authorization and work services. Securely link an authorized Shopify installation and eligible identities to the workspace; a standalone login does not itself grant Shopify API access or inherit staff permissions.

In both surfaces, the workspace, brand, and affected Shopify stores must be unmistakable. Embedded mode also shows its current host store. Cross-store reports and actions explicitly name their scope. A workspace filter must never silently change the store affected by a pending approval. Multi-store access depends on separately authorized installations and workspace grants.

Feature parity is the default for merchant workflows. Keep primary work and third-party connection settings usable inside Admin, with equivalent outcomes when a host-native interaction differs. Record any genuine platform limitation and its tested alternative; a smaller viewport is a layout condition, not grounds to remove features. Evaluate App Store distribution and Built for Shopify qualification separately. Shared screens do not establish review approval or badge eligibility by themselves. [Shopify integration guidance](https://shopify.dev/docs/apps/build/integrating-with-shopify), [Built for Shopify requirements](https://shopify.dev/docs/apps/launch/built-for-shopify/requirements)

## Dock workspace direction

The visual direction is option 1 for one shared workspace in two host modes. Hosting providers remain a package 1 decision. Shopify familiarity comes from understandable commerce objects, predictable controls, clear feedback, and safe editing. Dock-inspired project surfaces and contextual collaboration remain consistent across both modes; native host conventions determine the surrounding controls.

Dock documents a workspace with tabs for prose, structured records, rendered pages, and files. For our product, that idea maps to a project or work area within the merchant workspace: for example Autumn collection, with Brief, Products, Creative, Campaigns, and Results. This is a proposed UX mapping, not a new tenant or permission boundary. [Dock workspace tabs](https://trydock.ai/help/workspace-tabs)

| Area | Proposed treatment |
| --- | --- |
| Navigation | The shared destination model includes Home, Work, Inbox, Agents, Assets, Knowledge, and Settings, with contextual project navigation. Standalone mode provides its own sidebar; embedded mode integrates the same destinations with native app navigation and avoids redundant shell controls. |
| Main work surface | Persistent project header, clear brand and store scope, tabs for the actual documents, product records, creative assets, and results. Preserve location when switching tasks. |
| Contextual panel | Conversation, assigned agent, current task, sources, and recent activity beside the artifact being discussed. Panels can collapse; parallel chats are an optional advanced view. |
| Decisions | A persistent inbox for questions, approvals, and exceptions. Each type has distinct behavior; approval still binds an exact proposed change. |
| Agent management | Installed roles, private custom agents, readable capabilities, knowledge, routines, and Agent Store access. Keep the platform coordinator separate from optional business roles. |

Dock's anchored comments provide relevant context when work is handed to an agent. Adopt that interaction for a product row, a copy passage, or an image. In our system, the mention creates or updates a scoped work request; it does not independently authorize publishing, spending, or access expansion. [Dock comments](https://trydock.ai/help/comment-on-anything)

Dock's durable inbox preserves items that arrive while someone is away. Our adaptation adds explicit change review and commerce exceptions to this attention model. Marking a notification read must remain separate from approving its proposed action. [Dock Inbox](https://trydock.ai/help/your-inbox)

Use a collection-launch journey to develop and validate option 1: a merchant briefs the coordinator, specialists edit shared product and creative tabs, a human resolves a source question, an eligible reviewer approves exact changes, and verified publication appears in the same project. Also test an interrupted run and a restricted specialist. Assess navigation and review effort, not just visual similarity.

Do not make merchants manually coordinate many agent chats. Business objectives, current work, ownership, and required decisions should remain visible regardless of which specialist is open. Keep product selection, filters, bulk selection, before-and-after review, save protection, and publish semantics familiar to Shopify merchants.

## Information architecture

Use one logical route and destination model with clear workspace context, stable project locations, breadcrumbs where helpful, browser history, and authorized deep links. The standalone adapter owns its navigation controls. The Shopify Admin adapter maps the same destinations to supported native app navigation, including clear back behavior and avoiding duplicate Home destinations. Switching hosts preserves the authorized work location. [Shopify navigation guidance](https://shopify.dev/docs/apps/design/navigation)

| Destination | Proposed responsibility |
| --- | --- |
| Home | Business brief, active objectives, urgent decisions, recent outcomes |
| Work | Goals, projects, campaigns, tasks, conversations, dependencies |
| Inbox | Questions, approvals, access requests, exceptions, assignments |
| Agents | Installed agents, skills, routines, evaluations, builder |
| Assets | Product content, creative, reports, documents, tables, version history |
| Knowledge | Brand guidance, policies, approved facts, sources, merchant memory |
| Settings | People, roles, connections, stores, budgets, billing, notifications, governance |

Work and Assets provide resource views for catalog, campaigns, operational cases, and analysis, with links to native Shopify records when useful. Domain filters cover the broad business scope without adding a primary navigation entry for every specialist. The Agent Store lives inside Agents, clearly distinguished from the merchant's Shopify store. Connections remain accessible in Settings and from relevant setup flows.

At sufficient content width, a work detail combines conversation, current artifact, and activity. Their prominence follows the task: image review prioritizes images; an operational exception prioritizes the affected record and decision. At narrower widths, secondary panes become accessible tabs or drawers without losing actions or drafts. Base this behavior on the content container, not a standalone-versus-embedded flag. The standalone shell provides its own sidebar; embedded composition respects Shopify's surrounding navigation.

## Design tokens and surface components

Implement a shared accessible component system and feature screen library, specified in package 2. Reuse compatible components across both modes and isolate genuinely host-dependent controls behind adapters. Use current supported Polaris web components where appropriate in embedded work and App Bridge for Admin chrome. Do not duplicate screens into unrelated standalone and embedded implementations. React composition does not require the deprecated Polaris React library. [Polaris React archive](https://github.com/Shopify/polaris-react-archive)

Define shared tokens and semantic roles for surfaces, text, borders, spacing, density, status, emphasis, and motion. Both modes use the same workspace visual system and shared component behavior. Map host controls to supported Polaris and App Bridge properties rather than forcing identical CSS onto Shopify-owned chrome. Component choice, accessible event behavior, and host requirements belong in the package 2 inventory.

For Shopify-owned controls, avoid targeting component internals, injecting shadow-DOM overrides, or depending on undocumented selectors. Keep runtime and type versions compatible. Shopify's migration guidance moves embedded chrome and feedback into App Bridge and recommends validating component events in a development store. Encapsulate these rules in the embedded adapter; shared screens and standalone mode must work without host APIs. [Polaris migration guidance](https://shopify.dev/docs/apps/build/app-home/migrate-from-polaris-react)

Document common typography, spacing, icons, data formatting, status combinations, and content density, with explicit host exceptions. Shared screens own actions, validation, permissions, and work state; adapters own host-specific controls. Custom contact sheets and change comparisons retain keyboard access, action availability, and consistent interaction behavior in both modes. Test the same user journeys against both adapters.

Option 1 is the selected visual baseline: a neutral operational workspace with a pale canvas, clear artifact surfaces, charcoal text, subtle separators, small agent identities, left navigation where space and host conventions allow, a central work surface, and a collapsible contextual conversation panel. Final typography, tokens, contrast, responsive behavior, and component specifications are package 2 deliverables. Reserve semantic green, amber, and red for actual status. An agent's identity accent must not imply approval or safety. Avoid decorative gradients, oversized marketing headings, excessive card nesting, and making every task a chat bubble. Preserve supported native defaults for Shopify-owned controls.

For custom layouts, start with a 4 px spacing grid and 8, 12, 16, 24, and 32 px composition gaps. Use 24 px wide-content padding and 16 px narrow-content padding as package 2 prototype defaults. Validate the same component system at actual content widths in both modes. Define a readable typography scale and accessible control dimensions; use supported defaults for native host controls. Dense records must not shrink below a readable body scale to fit more columns. These proposed rules require baseline validation.

## Interaction semantics

Actions must describe their actual effect. Use distinct labels for Save draft, Run analysis, Generate images, Request approval, Publish changes, and Pause routine. Display the affected store, objects, and spending ceiling beside consequential actions. Saving configuration must not quietly activate a routine or publish its outputs.

Shared feature services own draft persistence, revision checks, visible saving state, and recovery after reconnect. The standalone adapter supplies unsaved-change protection for its routes and supported browser navigation. The Shopify Admin adapter uses Shopify's contextual save mechanism where appropriate, choosing form tracking or programmatic control per form. Opening the same work in another host resumes the persisted draft and revision; do not imply that unsaved local input transfers before a successful checkpoint. Standalone forms cannot call a missing host Save Bar API. [Save Bar API](https://shopify.dev/docs/api/app-home/latest/apis/user-interface-and-interactions/save-bar-api)

Expose one short-feedback interface to shared screens. The standalone adapter renders accessible application notifications; the Shopify Admin adapter uses supported native toasts. Questions, partial failures, approvals, and long-running work remain durable records visible in both modes, not transient notifications. [Toast API](https://shopify.dev/docs/api/app-home/latest/apis/user-interface-and-interactions/toast-api)

An approval shows the exact change, its source, current values where relevant, cost or spend limit, and scope. Editing the proposal creates a new version. The interface must show when a previous approval no longer applies. Answering a question, granting access, and approving an action remain visibly different interactions.

## Screen contracts

Each screen contract defines its purpose, essential information, main action, and evidence of success. Layouts can evolve while these responsibilities remain stable.

| Screen | Essential information and behavior | Successful outcome |
| --- | --- | --- |
| Home | Current workspace, brand, and explicit store scope; attention queue; active goals; recent verified changes; concise business brief with freshness. Offer a clear way to start or delegate work. | Merchant identifies the next useful action and understands current work without opening every conversation. |
| Work | Objective, owner, contributors, scope, status, outputs, dependencies, budget, and activity. Support conversation, artifact editing, reassignment, pause, and human takeover. | A person can explain progress, inspect the current output, and continue the task. |
| Inbox and Review | Separate question, approval, access, and exception types. Show eligible respondent, affected objects, exact proposal, expiry, and consequences. | The decision is unambiguous and attached to the correct proposal version. |
| Assets and resource views | Authorized resources, source freshness, native record links, drafts, approved assets, operational cases, and domain filters. Separate current store facts from proposed changes. | Merchant locates the right records and initiates scoped work with clear inputs. |
| Agent Store | Outcome-led listings, publisher, qualified capabilities, required connections, permissions, expected usage, sample work, compatibility, and release notes. | Merchant understands the role and installs an authorized configuration after a bounded sample. |
| Builder | Purpose, skill composition, required knowledge, connections, outputs, triggers, authority, limits, and sample results. Explain missing dependencies and ask structured questions. | Owner understands what the agent can do and activates an evaluated configuration. |
| Connections | Provider and account identity, permitted accounts/resources, current grants, health, synchronization state, and reconnect/disconnect controls. | Merchant knows which service is connected, what it enables, and how to resolve a connection issue. |

Home should avoid a wall of speculative recommendations. Rank items by relevance and consequence, and distinguish measured changes from agent hypotheses. A report card should link to its underlying evidence.

Work should make the current artifact easy to find. Expose detailed execution history progressively, using plain-language steps before technical traces. A task marked complete should identify accepted outputs and verified effects, including any remaining exception.

Review should support row-level or asset-level selection when partial approval is meaningful. Show the count and scope of selected items near the action. Bulk selection must remain clear after filtering, pagination, or switching views.

Builder should feel like configuring a capable colleague. Templates provide useful starting compositions; owners can refine instructions, knowledge, examples, and review rules. Permissions are requested separately from skills. A CMO configuration should expose its planning and specialist coordination abilities without implying unlimited publishing or advertising spend.

The platform coordinator is the entry point and task dispatcher. Chief of Staff and CMO are installable business roles with their own scope. The interface must not imply that a coordinator sees every private artifact or that installing a CMO gives it authority to increase advertising spend. The owner expertise workbench is a separate administrative surface for researching, evaluating, signing, and publishing first-party agent releases; it is not a merchant settings panel.

## States and recovery

The design system must include complete states before feature screens are considered ready. Generic loading spinners and generic error banners are insufficient for durable agent work.

| State family | Required treatment |
| --- | --- |
| First use and empty | Explain the area, its value, and the next available action. Distinguish no data from no permission. |
| Loading and running | Show stable layout, relevant progress, and what can continue independently. Avoid fabricated completion percentages. |
| Waiting | Explain whether a person, permission, provider, or schedule is blocking progress and identify the next responsible actor. |
| Stale and incomplete | Show freshness, missing sources, and limits on conclusions or actions. |
| Success and partial success | Identify completed outputs and changed resources; preserve unresolved items. |
| Failure and unknown outcome | Separate confirmed failure from an uncertain external result. Offer recovery without encouraging duplicate actions. |
| Conflict and expired approval | Explain what changed and provide an updated comparison or renewed review path. |
| Paused and cancelled | State which future work stopped and whether external jobs or completed effects remain. |
| Restricted and disconnected | Explain the relevant boundary and provide an eligible access or reconnection path. |

Use text and icons alongside color. Preserve drafts during recoverable failures. Connection or role changes must update visible capabilities and pending work, with clear explanations rather than silently disappearing actions.

## Mobile and accessibility

Mobile is a supported merchant working environment. Stack desktop panes; make conversation, artifact, and activity independently reachable. Keep review decisions and selected-item counts visible. Large tables can have a contained scrolling region or a focused detail view; the entire page should not require horizontal scrolling. Test text expansion and long translated labels.

Our proposed target is WCAG 2.2 AA. Relevant criteria include keyboard operation, focus visibility and obstruction, contrast, semantic labels, reflow, status announcements, accessible authentication, and alternatives to dragging. Target-size rules include exceptions; use the standard’s actual criteria rather than a simplified universal pixel claim. [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)

For this product, explicitly test image approval without a pointer, reading a change comparison with a screen reader, recovering from form errors, and navigating while an agent streams output. New activity should not continually steal focus or overwhelm announcements. Visual and automated checks support manual journey testing; neither alone demonstrates complete accessibility.

## Standalone visual options

The owner selected option 1 on 6 October 2026; ADR-0032 replaced it with Sunrise on 23 October 2026, and these studies are kept as history. Its spacious standalone composition is the visual reference for the shared workspace in both modes. The numbers match the order displayed in the conversation; options 2 and 3 remain unselected references. Work follows the existing 18-package build plan beginning with package 1; package 2 develops the selected direction into a tested interaction baseline. These are visual studies with synthetic merchant data, not implemented software.

### Option 1 selected

![Standalone workspace option 1](library-file:fde1_bGliZmlsZV92cUdaZUNwaUE0S0V1TllORTZBNFR3_FileDrive_23e44df0543c8191ad13335c09e40163)

### Option 2

![Standalone workspace option 2](library-file:fde1_bGliZmlsZV9EZkRySk13eTJxUjlVUng3bzh1OGZR_FileDrive_23e44df0543c8191ad13335c09e40163)

### Option 3

![Standalone workspace option 3](library-file:fde1_bGliZmlsZV9RWFdvMVdOOFBBcW5RWFFBek8xbXRn_FileDrive_23e44df0543c8191ad13335c09e40163)

## Superseded embedded visual studies

These three initial studies show collection preparation and review within an illustrative Shopify Admin shell. They remain unselected visual references. Adapt the selected option 1 workspace to Admin in package 2 rather than treating the earlier embedded studies as a separate product design.

### Concept one

![Workspace visual concept 1](library-file:fde1_bGliZmlsZV96RFN2UVAybDhobjJSSHNUcHZULWR3_FileDrive_23e44df0543c8191ad13335c09e40163)

### Concept two

![Workspace visual concept 2](library-file:fde1_bGliZmlsZV9IdEZzc0VvcW9uYko1MkUyY1g1WERB_FileDrive_23e44df0543c8191ad13335c09e40163)

### Concept three

![Workspace visual concept 3](library-file:fde1_bGliZmlsZV9jYi1XOVM2d2YxZmdYaGpPZEtROElB_FileDrive_23e44df0543c8191ad13335c09e40163)

Validate the selected option 1 direction for comprehension, navigation, decision clarity, accessibility, visual cohesion, and merchant familiarity in both host modes. Retain useful elements from the earlier studies where they support the shared design. A generated mockup does not establish feasibility, usability, or completion of the frontend design gate.

The earlier recommendation of embedded concept one is superseded by the selected option 1 workspace design. These retained images used the public Dock homepage as a reference for restraint, not a captured authenticated Dock workspace. Their Shopify host chrome is illustrative. Synthetic text, dates, images, counts, status colors, and product claims are not production specifications. Final review counts come from actual proposals, and factual product claims require merchant evidence.

## Validation and design gate

Treat App Store approval and Built for Shopify qualification as separate outcomes from shared workspace quality. Assess eligibility for the actual embedded app and connected experience; the chosen hosting model does not imply a badge. Current Built for Shopify performance criteria include p75 LCP at most 2.5 seconds, CLS at most 0.1, and INP at most 200 milliseconds, with sampling and eligibility conditions. These can also inform proposed standalone performance targets, measured independently. Load navigation and task summaries promptly; measure model latency separately. Recheck qualification criteria before release. [Built for Shopify requirements](https://shopify.dev/docs/apps/launch/built-for-shopify/requirements)

Option 1 is selected for the shared workspace. Resume the existing build plan at package 1 contracts and external dependencies. Package 2 then establishes the reviewed interaction baseline: information architecture, component and token rules, screen contracts, host-adapter behavior, parity matrix, critical journeys, state inventory, and accessibility. Prototype the same workflows at wide and narrow content widths in both modes before frontend feature construction. Visual selection does not mean these deliverables or qualification tests are complete. Keep all 18 packages and their dependency order.

Proposed user-test gates are measurable targets for evaluation, not observed results. Test with both small-brand owners and specialist team members using realistic store and role contexts.

- At least 90 percent of representative task attempts reach the intended destination and complete without moderator intervention.

- Every participant can identify the affected store and distinguish a draft from a live change before confirming a consequential action.

- No tested approval journey produces an unintended scope or spending interpretation. Revise and retest any such failure.

- Participants can find the latest artifact, identify the owner, and explain the next step of a blocked task.

- All critical journeys work with keyboard navigation; screen-reader testing reveals no blocking issue.

- Mobile participants can complete review, reconnect a service, and inspect an agent’s output without inaccessible controls.

Record task completion, errors, recovery, unnecessary navigation, and requests for explanation. Small usability studies guide iteration; they are not statistical proof of overall product success.

App Store readiness remains a separate gate for the Shopify app and its connected experience. Assess distribution and embedded workflow coverage during package 1. Embedded mode must meet current requirements for consistency, App Bridge, installation and reinstallation authentication, and operation without dependency on third-party cookies or local storage. Standalone mode needs secure authentication, sessions, deep links, and recovery. Test both through the same feature journeys and backend authority checks, including cross-host continuity and revocation. [Shopify App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)

After the foundation is accepted, feature teams work within it and bring evidence-based changes back to the design system. Freeze shared decisions for implementation, then revise them deliberately when user research, platform changes, or real operational behavior justify an update.
