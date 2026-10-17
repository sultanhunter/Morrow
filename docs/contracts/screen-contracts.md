# Workspace screen contracts

P02.T01, canonical sequence 24. Owner Morrow platform owner; reviewer Codex, same implementer. Every domain screen is standalone; responsive collapse preserves functions. Catalogue data/component/state names are specification ports, not API implementations.

| Screen | Essential information | Main action and observable success |
| --- | --- | --- |
| Home | Workspace/store scope, relevant decisions, objective owners, verified outcomes, source freshness | Start work; locate next responsible person/action |
| Ask workspace | Selected scope, coordinator identity, linked task, missing inputs, estimated credit ceiling | Describe objective; durable linked work or explicit setup question |
| Work/task | Objective/owner, affected stores, contributors, status/dependencies, output revision, held budget, conversation/activity | Continue the task and find its latest output without searching chats |
| Inbox/question | Distinct item type, respondent, task/source context, required answer, expiry | Answer once; question revision and task update visible; no implied approval |
| Review | Exact store/account, proposal revision, before/after, selected objects, costs, evidence, reviewer eligibility, expiry | Approve exact change or request revision; approval is separate from verified publication |
| Exception | Known versus uncertain provider effect, affected record, evidence, owner and safe next step | Reconcile/resolve; never offer blind retry for uncertain writes |
| Assets/catalog/product | Current store facts, drafts, versions, freshness, selection scope, native links and access | Locate authorized resource, create scoped work or inspect changes |
| Artifact | Current immutable revision, lineage, source restrictions, edit/review state | Save a new draft revision or recover conflict; no silent publication |
| Agents/detail | Installed release/publisher, capabilities, connections, current scope, routines/usage/health | Inspect/disable/configure; an agent title never expands authority |
| Agent Store/listing | Outcome, publisher/release, requirements/permissions, compatibility, expected credits and bounded sample | Understand dependencies and sample; installation is not auto-activation |
| Builder/draft | Purpose, research-backed skills, missing inputs, knowledge/connections, outputs, mandate/limits, sample | Save configuration, answer question, evaluate; activation is a separate eligible action |
| Knowledge/detail | Approved fact/policy versus hypothesis, source/version/freshness, lineage and access | Inspect source or propose revision; unsupported claims remain explicit |
| Settings/connection | Account/store identity, current grants, sync health/freshness, people/roles, usage and billing responsibility | Eligible reconnect/disconnect or setting save with effect explained |
| Thin Shopify connector | Verified shop/link status and allowed connection controls; return to Morrow | Complete eligible linking/recovery, then return; no workspace execution |
| Operator authoring | Separate operator identity, research/evaluation/review/publishing lifecycle | Qualified release publication; never a merchant-settings permission shortcut |

## Shared state requirements

Loading keeps layout stable without fabricated progress. Empty distinguishes no data from no permission. Running/waiting names next responsible actor. Missing connection or grant offers an eligible setup route. Stale/incomplete content states source/time and limits conclusions/actions. Conflict preserves both drafts; expired/changed approval opens renewed comparison. Partial success lists item outcomes. Unknown provider effect retains uncertainty and a reconciliation path. Paused/cancelled distinguishes future work from already submitted/completed effects. Offline preserves recoverable local edits while avoiding a false Saved claim.

Actions name actual effects: Save draft, Run analysis, Generate images, Request approval, Approve changes, Publish changes, Pause routine, Reconnect, Disconnect. Review always repeats pinned target/count/ceiling beside the action. Unread is not unapproved; marking read does not approve. Approval, answer and access request have distinct forms.

Work panes are artifact-first, with contextual team/agent conversation and durable decisions. At narrow width, explicit controls switch Artifact/Conversation/Activity and restore focus without losing drafts. Primary navigation collapses into an accessible drawer. Dialogs contain focus, have labelled titles and return focus to the opener. Updates announce concise status and do not steal focus while streaming.

Screen ports consume P01 contracts through backend services. They never trust a browser role, host flag, displayed plan or model text. Prototype content is synthetic and visibly marked; it does not establish connection, provider outcomes, live publication, grant ownership or merchant value.
