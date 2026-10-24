# Work HTTP API v1

Version: 1. Owner: Morrow platform owner. Decision: ADR-0010 item 3 (accepted 2026-10-17). Packet: P06.T01a. Implementation: `@morrow/work/http` behind the api Worker.

This is an **internal JSON contract** between the api Worker and Morrow's own SPA, not a third-party API. Additive changes are routine; a breaking change needs a superseding ADR. It serves only the api Worker (Workers runtime); the Node development listener does not serve it.

## Transport

- **Routes** live under `/workspace/:ws/work`, inside the `/workspace/*` namespace the api Worker serves ahead of Static Assets (`run_worker_first`). `:ws` and every path ID are v1 `Id`s.
- **Authentication** is exactly one canonical `__Host-morrow_session` cookie. `Authorization` or `Proxy-Authorization` is 401. The workspace and the actor are resolved from the session on the server; a client never supplies organization, workspace or principal identifiers as authority, and a body carrying them is 400.
- **CSRF protection** (no synchronizer token, ADR-0010, P05.T01x §13.2): the request URL must have the exact configured HTTPS origin; `Host`, when present, must match it; `Origin` must equal it (required on POST); `Sec-Fetch-Site` same-origin or absent; `Sec-Fetch-Mode` cors, same-origin or absent; `Sec-Fetch-Dest` empty or absent. POST also requires `Content-Type: application/json` exactly and `X-Morrow-Request: 1`. There are no CORS headers.
- **Commands** (POST) require a lowercase UUID `Idempotency-Key`. A GET with a body, `Content-Type` or `Idempotency-Key` is 400. `Transfer-Encoding` is 400.
- **Bodies** are at most 64 KiB of strict UTF-8 JSON: duplicate member names, lone surrogates and `\u0000` anywhere are 400. Every body is a closed record.
- **Responses** are JSON with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; never `Set-Cookie`. Every success body carries `schemaVersion: 1`. The request deadline is 5 s.

## Idempotency and outcomes

- A command is identified by its actor and `Idempotency-Key`; keys are scoped per actor (`docs/contracts/work-state.md`).
- The request digest covers the command type, the workspace, the path IDs and the body with object keys sorted. The same key and digest **replay**: 200 with the original result and `replayed: true`, provided the actor still has a current session and `view` on the aggregate's read capability (otherwise 404). The same key with another digest is 409 `conflict`/`never`.
- Every command rechecks authority under lock and commits its outbox event in the same transaction as its effect. Denials and conflicts persist nothing.
- `503 uncertain`/`reconcile_before_retry` means the command function or COMMIT was sent and its reply was lost. Retry with the **same key and body**: the retry replays the original result or applies once. Never retry an uncertain command with a new key.

## Routes

`O`/`W` are the actor's organization and workspace. Request bodies are closed; the server builds and validates the v1 capability input.

| Route under `/workspace/:ws/work` | Body | Success |
| --- | --- | --- |
| `GET /goals?after=&limit=` (limit 1–25, default 25) | – | 200 `{items: Goal[], next}` |
| `GET /goals/:goalId` | – | 200 `{goal}` |
| `POST /goals` | `{objective, storeIds, successCriteria}`; non-empty `storeIds` is 403 | 201 `{goalId, revision}` |
| `POST /goals/:goalId/status` | `{to, expectedRevision}` | 200 `{status, revision}` |
| `GET /tasks?goalId=&status=&after=&limit=` (limit 1–50, default 50) | – | 200 `{items: Task[], next}` |
| `GET /tasks/:taskId` | – | 200 `{task}` |
| `POST /tasks` | `{goalId, objective, allowedResources}`; `allowedResources` is `[]` or `[W]` | 201 `{taskId, revision}` |
| `POST /tasks/:taskId/status` | `{to: "ready", expectedRevision}` | 200 `{status, revision}` |
| `POST /tasks/:taskId/assignment` | `{assigneeId, expectedRevision}` | 200 `{assignmentId, revision}` |
| `GET /tasks/:taskId/questions?after=&limit=` (limit 1–50) | – | 200 `{items: Question[], next}` |
| `POST /tasks/:taskId/questions` | `{question, respondentId}`; the answer schema is the built-in `morrow.answer.text` | 201 `{questionId, status}` |
| `GET /questions?respondent=me&status=&after=&limit=` (limit 1–50) | – | 200 `{items: Question[], next}` |
| `GET /questions/:questionId` | – | 200 `{question}` |
| `POST /questions/:questionId/answer` | `{text, expectedRevision}` | 200 `{answerRevision, answerRef}` |
| `POST /questions/:questionId/status` | `{to: "cancelled", expectedRevision}` | 200 `{status, revision}` |
| `GET /questions/:questionId/answer` | – | 200 `{answer: {id, questionId, body, answeredBy, createdAt}}` |

- **Text** (`objective`, `question`, `text`) is 1–8192 Unicode characters. `successCriteria` is 1–20 v1 criteria. A `next` cursor is opaque; pass it back as `after`.
- **Objects.** Every Goal, Task and Question is a v1 object that passes the generated validator before it is sent (otherwise 503). Goal: `storeId` null, `taskIds` derived (a new task does not bump the goal revision), scope `{O, W, [], [], [W], []}`. Task: `parentTaskId` and `activeRunId` null, reference lists `[]`, `leaseGeneration` 0. Question: `eligibleRespondentIds = [respondent]`, `blocksTask: false`, `expiresAt: null`, `answerSchemaRef = {O, W, null, "schema", "morrow.answer.text", 1, sha256(canonical schema)}`. The answer's `AnswerRef` is `{O, W, null, "answer", answerId, 1, sha256(text)}`.

## Permissions

The vocabulary is `@morrow/contracts/work-permissions` (ADR-0010 item 1). The resource is always `W`. Creates need `execute`; on an existing record, ownership selects the verb (own → `execute`, other → `administer`) and a grant is always required. Reads are `view` on the capability that creates the record and request every non-metadata field they return; an uncovered field is 403, never a partial object. Answers are `execute` on `workspace.question.answer` by the designated respondent only. An assignee must currently hold `view` on `workspace.task.create`; a respondent `execute` on `workspace.question.answer` and `view` on `workspace.question.request` (ADR-0010 item 4).

A record the actor may not view is 404, identical to an absent one; a list the actor may not view is 403.

## Errors

Errors are v1 `ErrorEnvelope`s with a fixed `safeMessage`; a not-found body is byte-identical apart from `correlationId`. Database error text is never returned or logged.

| Condition | HTTP | `code` / `retryClass` |
| --- | --- | --- |
| No valid session, not a member, revoked | 401 | denied / never |
| Malformed path, query or body | 400 | missing_input / never |
| Guard failure; verb, field or scope denied; more than 1000 grants | 403 | denied / never |
| Absent, foreign or not viewable | 404 | denied / never |
| Wrong method (with `Allow`) | 405 | denied / never |
| Revision, state or guard conflict; authority changed during the command, the actor's or the assignee's or respondent's grants included | 409 | conflict / recheck_before_retry |
| Key reused with another request; ineligible assignee or respondent; published limit | 409 | conflict / never |
| Over the api's per-address session limit, answered before this API runs (`Retry-After: 60`, `retryAfterSeconds` 60) | 429 | rate_limited / recheck_before_retry (GET: safe_read_retry) |
| Database unavailable before the command was sent | 503 | unavailable / recheck_before_retry (reads: safe_read_retry) |
| Command or COMMIT sent, reply lost | 503 | uncertain / reconcile_before_retry |

## Goal and plan routes (PR 18; ADR-0033, ADR-0034)

Routes under `/workspace/:ws/work`, all behind `docs/decisions/plan-drafts-staging.json` (committed `off`, `start_routes` `held`). Goals are validated with the current definition (Goal and CriteriaList v1.1, declared supersets of v1), never v1, which would answer 503 for a measured goal. `POST /goals` keeps its v1 body: a criterion with `key` or `measure` is 400 there, because a measured goal belongs to a project's goal record, made by the plan start or revised by a person.

| Route | Body | Success |
| --- | --- | --- |
| `POST /goals/:goalId/revise` | `{expectedRevision, objective, dueAt, successCriteria}` | 200 `{revision}` |
| `POST /goals/:goalId/checks` | `{key, productId, assistant, answers}` | 201 `{valueId, counted}` |
| `GET /goals/:goalId/progress` | – | 200 `{progress}` (GoalProgress@1, for this viewer) |
| `POST /plans/start-document` | `{messageId, draftDigest}`, or `{card}` for a code-built card | 201 `{documentId, documentDigest, expiresAt, document, nonce}` |
| `POST /plans/start` | `{documentDigest, nonce}` | 201 PlanStartResult |

- `revise` and `checks` are `workspace.goal.revise` and `workspace.goal.measure.record` (`human_only`): a stored measure's `startRef` stays null, a body carrying one is 400, and a check's value, read tags, class and clock are the server's. A check in another assistant than the goal's is kept and never counts, nor does a check once a revise changes the goal's assistant or removes its product row. `revise` takes 1 to 3 criteria, every one measured (a project's goals), and never revises Quick tasks or a v1 goal (409). At most 3 checks per goal, key, product row and UTC day (409 `limit_reached`).
- Goal reads (`GET /goals`, `GET /goals/:goalId`, `progress`, and the record `revise` and `checks` act on) leave out a customer-class goal (Customer emails' "Replied within a day") unless the viewer may view `support.case.read` on the workspace's stores (ADR-0033 Consequences). A record with no other goal reads as absent: 404, and left out of a list (the cursor is unchanged). A `revise` of a record with a goal the person may not see is 403 `denied`.
- `progress` is computed per viewer under read tags (ADR-0031 item 6): a goal whose tags the viewer may not view is left out of the goals and of the project's word, never counted. A tag is viewable when the kernel allows `view` on its capability and store resource for the fields one of the viewer's view grants on that capability names; with no such grant, or no current association for the store, it is not.
- Every goal revision (`revise`, or a plan change through the start) appends one `goal.revised` event (empty payload; the envelope carries the goal's id and revision), so a goal's aggregate revisions on the stream stay contiguous.
- The start routes answer 503 `unavailable` before any document, lock or record while `start_routes` is `held` (until `lab:plan-start` passes); while the switch is `off` they accept only code-built cards (an Everyday work area, Quick tasks or Finish). A start document is issued only to the asker (or, for a code-built card, the person opening it) on a standalone-workspace session; any other actor, an agent, an embedded or email session is 403 `actor_ineligible`. Quick tasks is set up only by the Owner (ADR-0024): anyone else is 403 `denied` ("Only the workspace owner can set up Quick tasks."), checked again by both definers under lock. A plan change aimed at the Quick tasks project is 409 `state_conflict`. A card aimed at an existing project reads its goal record as the goal reads do: 404 without goal view, or when every goal is hidden from the person; a goal-changing plan change of a record holding a goal the person may not see is 403 `denied`, as `revise` is. Morrow's card never sees a customer-class goal, so the start keeps each, unchanged, after the card's goals; a kept key the card also names, or a fourth measured goal, is 409 `state_conflict`. It lasts 5 minutes and is consumed once; an expired, reused or unknown digest, or a draft, target, assignee or grant summary that changed, is 409 `stale`. The start re-runs the human kernel for every piece under live grants and the definer rechecks authority under lock; any refusal (`denied`, `stopped`) rolls everything back. It never admits a run: each step's run is admitted after commit on its own, and while the agent loop is off every step is `not_started` with its reason.

## Agents routes (M3 PR-1)

An internal JSON contract beside the work API, under `/workspace/:ws` (not `/work`), on the same api Worker, dependencies and guard rules (`packages/work/src/agents/http.ts`; ADR-0022 items 3, 15 and 16, with the item 3 amendment of 2026-10-20). `PUT` follows the `POST` rules: exact `Origin`, Fetch Metadata, `X-Morrow-Request: 1`, `Content-Type: application/json` and an `Idempotency-Key`. Bodies are closed and never carry a tenant, store connection, installation or actor value: the store comes from the path and is resolved against its current association. Every command runs the human kernel on the exact resource first, then its definer, which rechecks authority under lock. An unbound api answers 401 with no network or database access. Errors are the work API's envelopes (above), the session limit's 429 included.

| Route under `/workspace/:ws` | Body | Success |
| --- | --- | --- |
| `GET /stores/:storeId/agents/listings` | – | 200 `{storeId, linked, blocked, installation: {installationId, status, revision, stopped, updatedAt} \| null, actions: {enable, resume, stop}}` |
| `POST /stores/:storeId/agents/listings/document` | `{}` | 201 `{documentId, documentDigest, installationId, purpose: "enable" \| "resume", expiresAt, document, nonce}` |
| `POST /stores/:storeId/agents/listings` | `{documentDigest, nonce}` | 200 `{installationId, revision, status: "active", purpose, documentDigest}` |
| `POST /stores/:storeId/agents/listings/stop` | `{control: {reason, sourceProposalRef: null}}` | 200 `{status: "disabled", killSwitchRecordId, priorStateObserved, stopId, installationId, revision, pendingOperations: []}` |
| `GET /models` | – | 200 `{catalogueVersion, entries: [{model, effort, creditsPerProduct, runProductLimit, allowedForMember}], workspaceDefault: {model, effort}, ceiling, revision, canRevise, draftingAvailable}` |
| `PUT /settings/model-default` | `governance.model_default.revise` input `{model, effort, maxCreditsPerProduct, expectedRevision}` | 200 `{revision, model, effort, maxCreditsPerProduct}` (the recorded result; a replay returns the same body with `replayed: true`) |

- **Enable and resume** (the confirm screen). Step 1 needs `agents.installation.activate` `{execute}` on the store resource, with fields `grant` and `installationId`, and every verb the installation receives (`catalog.products.read` view, `catalog.content.propose` execute, `catalog.content.publish` propose, on the store and the listing fields). The server builds the installation document: the release `morrow.listings` v1 and its digest, the store resource, the installation id, the exact grant set and the owner's `agents.installation.disable` grant. It binds the document to the actor and the session for five minutes and returns its single-use `nonce` once; only the nonce's digest is stored. Step 2 reruns the kernel against current authority and sends the document's digest and nonce. Under the organization interlock, the definer checks the actor, session, expiry, nonce, release, store connection, platform and connection stops and the installation state against the document, then creates the installation's and the workspace Coordinator's agent principals, issues the three grants (each exactly the document's, through the identity bridge's allowlist) and the owner's disable grant, and consumes the document. `resume` is offered only after the owner's own "Stop AI work" (a person's installation stop with its KillSwitchRecord), and only when the installation is exactly what its document names: the release digest, the store resource with its connection, and the grant set (the installation's stored grants, unrevoked and unexpired, each equal to the document's). Both steps compare them, in the Worker and in the definers, and any difference is 409 conflict (state); such an installation is uninstalled and enabled afresh. The resume document records the stop open when it was built; the confirmation lifts only that stop, as a person, and reactivates the installation, so a stop set after the document was built stays (409 conflict). Platform and connection stops are lifted only through their own paths: a resume under one is 409 conflict and changes nothing. A wrong, expired, reused or another session's document is 409 conflict (guard); another actor's document is not this actor's to read, so the Worker answers 404 (the definer, called directly, refuses it as guard). An existing installation is 409 conflict (state).
- **Stop AI work** needs `agents.installation.disable` `{execute}` on the installation resource (fields `control`, `installationId`). `checkKillSwitchTarget` accepts the target, and the KillSwitchRecord commits with the installation stop, which revokes its run and operation leases, and with `kill_switch.executed`. Stopping again records `already_stopped`. The record's `priorStateObserved` is the Worker's read; if another stop committed before the definer's lock, the request is 409 conflict (recheck), and a retry records `already_stopped`. `blocked` in the status read is true while a platform stop or a stop on the store's connection is open: no AI work runs although the installation may be active. It never reads entitlement or credits, and it works whether or not the store's association is current.
- **Models.** Any current member may read `GET /models`. It names opaque catalogue keys only, never a provider model string, price, cost or token limit. `allowedForMember` applies the member ceiling unless the reader holds `governance.model_default.revise`. `draftingAvailable` (M3 PR-2) is whether run admission is open in this deployment (the runs handler's own flag), so Ask writes no goal or task while it is not. `PUT` needs that capability. It accepts only keys of the active catalogue version and a ceiling (1–99) that admits the default. `expectedRevision` is null for the first row; anything else stale is 409 conflict.

## Runs routes (M3 PR-2)

An internal JSON contract beside the work API, under `/workspace/:ws/work`, on the same api Worker, dependencies and guard rules (`packages/work/src/runs/http.ts`; ADR-0022 items 2, 3, 9-11 and 16). The api's dispatch table sends exactly these paths to it, ahead of the work API's row. Bodies are closed: admission names a store id, product ids, listing field paths and opaque catalogue keys, never a tenant, installation, actor, provider, price or credit amount. An unbound api answers 401 with no network or database access.

| Route under `/workspace/:ws/work` | Body | Success |
| --- | --- | --- |
| `POST /tasks/:taskId/runs` | `{storeId, products: [product:<n>] (1-25 distinct), fields: [field paths] (1-5, both SEO fields or neither), selection: {model, effort} \| null}` | 201 `{runId, status: "queued", childTaskId, productCount, creditsReserved, catalogueVersion, selection: {model, effort}}` (a replay returns the same body with `replayed: true`) |
| `GET /tasks/:taskId/runs` | – | 200 `{runs: [run]}` (newest first, at most 20) |
| `GET /runs/:runId` | – | 200 `{run, credits: {reserved, settled, status}, usage: {attempts, inputTokens, outputTokens}, products: [{index, productId, status, attempts, failureCode, proposalId, flags}], interrupted}` |
| `POST /runs-reconcile` | `{}` | 200 `{closed}`, the actor's own runs closed (a replay returns the same body with `replayed: true`) |

A `run` is `{runId, revision, taskId, childTaskId, storeId, status, endedReason, selection, catalogueVersion, creditsPerProduct, productCount, fields, productsDrafted, productsFailed, createdAt, startedAt, endedAt, updatedAt}`. `flags` are the reviewer flags as counts (`newUrls`, `newEmails`, `newPhones`, `tagsAdded`, `tagsRemoved`). No read returns a draft's text, a product as read, a provider request or model id, a raw stop reason or a per-call cost.

- **Admission.** While the model-provider switch is off (`MORROW_MODEL_PROVIDER` absent), or M2 PR-3's product read does not exist yet (the orchestrator could start no run), admission is 503 unavailable (`recheck_before_retry`, "AI drafting is not available yet.") before any database access. Otherwise, in one transaction: the parent task is the actor's own and draft or ready; the store's association is current and its Listings installation active; the human kernel allows `execute` on `catalog.content.propose`, `view` on `catalog.products.read`, `delegate` on both, and `propose` and `delegate` on `catalog.content.publish`, on the store resource and the fields; entitlement through `entitlementFor` over M5's billing facts and a billing period exist; the selection resolves against the active catalogue within the member ceiling (`governance.model_default.revise` exempts; null is the workspace default); the products fit the selection's run limit. The code Coordinator writes CoordinatorRoute@1. `cmd_run_admit` rechecks every data rule under the P06.T01a prelude, derives the billing account, entitlement, period and cost allocation in SQL, closes the workspace's stale runs, reserves credits and vendor cost, opens the run lease and creates child task T′ (ready, owned by the requester), the envelope, the Coordinator's 24-hour `workspace.task.delegate` grant on T, the hop, the run, its products and manifest, and `task.created`, `task.status_changed` and `run.admitted`. The orchestrator's cron starts the run from `pending_starts()`.
- **Refusals** persist nothing. Not entitled, or no billing period: 403 denied ("An active Morrow plan is required to draft listings."). Not enough credits, the daily cap, the unrecovered-cost cap, or more products than the selection allows: 409 `budget_exhausted` / never. An unknown or retired selection: 400 missing_input. A selection above the member ceiling: 403 denied. A stopped store, or no active Listings installation: 409 conflict / never. Live pending approvals under the current review policy that, with one proposal per product, would pass the 1,000 cap: 409 conflict / never ("Too many changes are waiting for review. Approve or reject some, then try again."). A foreign or absent task or store: 404. A run whose proposals are refused when it proposes (the cap reached meanwhile, or any refusal but a stale review policy) ends as `proposal_refused`; its drafted products' cost accrues as unrecovered and its credits return.
- **Reads** are gated as every work read (P06.T01a §4.7): `view` on `task.read` first (a run belongs to its task, whose read lists `activeRunId`), so a single run the actor may not view is 404, identical to an absent one, and a task's runs are 403; then `view` on `catalog.products.read` on the run's own store resource with the run's fields, so a run on a store the actor may not read is 404 and is left out of a task's runs.
- **Reconcile** needs `view` on `task.read` (403 denied otherwise) and closes the actor's own interrupted runs; another member's interrupted run closes at the next admission in the workspace. An interrupted run is one still queued or running whose lease a stop revoked or which outlived its 30-minute lease. Its open model calls are booked as uncertain at their worst case, products in progress fail as `interrupted` and their cost accrues as unrecovered, the credits settle at the products proposed (the rest returns), and the run moves to `cancelled` through the `work_service` edges, with `endedReason` `stopped` or `lease_ended`. `interrupted` in the run read says the close applies.

## Catalogue routes (M2 PR-3)

Two reads of a linked store's catalogue for the Ask screen's picker, under `/workspace/:ws` on the same api Worker, dependencies and guard rules (`packages/work/src/catalog/http.ts`; spine §4; the M2 brief's api routes). They take only their own query parameters, with closed values: `after` is an opaque cursor of at most 1,536 base64 characters (Shopify's title-sorted cursors hold the last title; these routes accept a URL of up to 6,144 characters to carry one percent-encoded, where other routes keep 512 a value and 2,048 a URL); `collectionId` is `collection:<digits>`; `query` is at most 64 letters, digits and single spaces. Anything else is 400 before any SQL or Shopify call.

| Route under `/workspace/:ws` | Query | Success |
| --- | --- | --- |
| `GET /stores/:storeId/catalog/collections` | `after` | 200 `{schemaVersion: 1, collections: [{id, title}], nextCursor, storeId}` |
| `GET /stores/:storeId/catalog/products` | `after`, `collectionId`, `query` | 200 `{schemaVersion: 1, products: [{id, title, status}], nextCursor, storeId}` |

- One READ WRITE transaction: the session's authority, the store's current association, then the human kernel must allow `view` on `catalog.products.read` on the store resource with the listing fields (403 otherwise), then `morrow_work.catalog_read_lease` opens a 60-second `read` lease for the session's tenant and actor (409 conflict under a connection stop; 404 when the store has no current connection). The lease selects the tenant of the one read; it grants nothing.
- After COMMIT, one `ApiBroker.shopifyRead` under that lease. The broker resolves the lease, its stops, the store connection and the credential itself, runs one fixed Admin GraphQL document with variables it builds (a title search becomes `title:<word>*` terms) and returns ids (`collection:<n>`, `product:<n>`), titles and a lower-case product status only. A missing collection is 404. A refused, failed or throttled-past-budget read, or one held because the broker's read slots are busy, is 503 unavailable / safe_read_retry. Page size is 25. The whole request has a 9-second deadline; the read gets whatever the transaction leaves of it less 250 ms, never more than the protocol's 15-second budget.
- Shopify's reply, the token and any provider text never reach the response or a log; each request logs one fixed `morrow_catalog` line (route and outcome).

## Connection routes ("Disconnect store")

A person's kill switch on one store connection, under `/workspace/:ws` on the same api Worker, dependencies and guard rules (`packages/work/src/connections/http.ts`; ADR-0022 items 2, 3, 13 and 15 with the amendments of 2026-10-22; ADR-0005; `docs/briefs/v1-disconnect-store.md`). Only exactly `/connections/:connectionId/disconnect` comes here; every other `/connections` path stays the managed workspace handler's (`WorkspaceConnections@1`).

| Route under `/workspace/:ws` | Body | Success |
| --- | --- | --- |
| `GET /connections/:connectionId/disconnect` | none | 200 `{schemaVersion: 1, connectionId, storeId, installationStatus, stop, actions: {disconnect}}` |
| `POST /connections/:connectionId/disconnect` | `{control: {reason, sourceProposalRef: null}}` | 200 `{schemaVersion: 1, status: "disconnected", killSwitchRecordId, priorStateObserved, stopId, connectionId, storeId, installationId, installation, endReason, credential}` (`replayed: true` on a replay) |

- The connection is resolved against the session tenant's store installations that were ever linked into this workspace; any other id is 404. `installationStatus` is `linked`, `suspended` or `uninstalled`; `stop` is the open connection stop (`{setBy: human | system | operator, reasonCode, createdAt}`) or null; `actions.disconnect` is true only when the kernel allows it, the installation is linked and no stop stands. Any session-eligible member may read it; ids and codes only, never the reason.
- The command needs `governance.connection.disconnect` `{execute}` on the store resource with fields `connectionId` and `control` (store-link template v2 issues it to the linking owner), 403 otherwise. It never reads entitlement or credits. `checkKillSwitchTarget` accepts the connection, then one definer, in one transaction: the installation ends (`suspended`, end reason `disconnected`), the `KillSwitchRecord` (its target `{kind: connection, id: connectionId, storeId, connectionId}`) commits with the person's connection stop (`human_disconnect`), which revokes every read, run and operation lease on the connection, and `kill_switch.executed`. Disconnecting again records `already_stopped` and changes nothing else; a stop committed between the Worker's read and the definer's lock is 409 conflict (recheck).
- After COMMIT, one `ApiBroker.shopifyCredentialDestroy` erases the disconnected installation's offline token. `credential` is `destroyed` only when the broker confirmed it; otherwise `pending` (the connector's cron finishes it), and the disconnect stands either way. A replay asks the broker again.
- A disconnect deletes no store content and starts no deletion clock (ADR-0031 item 3). In this release it cannot be undone: reconnecting needs a new install. Each request logs one fixed `morrow_connections` line (route and outcome).

## Shop knowledge and notebooks (PR 20)

Pages for brand voice, policies, product facts, suppliers and decisions, each with versions and sources, and each installed agent's notebook, under `/workspace/:ws/work` on the same api Worker, dependencies and guard rules (`packages/work/src/knowledge/http.ts`; ADR-0031 items 1, 2, 4 and 6; ADR-0024; `docs/briefs/shop-knowledge.md`). The api's dispatch table sends exactly these paths here, ahead of the work API's row. Behind `docs/decisions/shop-knowledge-staging.json` (committed `off`): every route answers 503 `unavailable` ("Shop knowledge is not available yet.") before any body work or connection. Bodies are closed and typed text only (no uploads, never a NUL): a body never names a tenant, read tag, author, version number or digest the server assigns.

| Route under `/workspace/:ws/work` | Body | Success |
| --- | --- | --- |
| `GET /knowledge/pages` | – | 200 `{pages: [KnowledgePageSummary], pendingProposals, may: {write, delete}}` |
| `POST /knowledge/pages` | `{kind, title, text, sources}` | 201 `{pageId, version: 1}` |
| `GET /knowledge/pages/:pageId` | – | 200 `{page: KnowledgePage, versions: [{version, author, acceptedByPrincipalId, proposalId, createdAt}]}` |
| `GET /knowledge/pages/:pageId/versions/:version` | – | 200 `{version: KnowledgeVersion}` |
| `POST /knowledge/pages/:pageId/versions` | `{expectedVersion, title, text, sources}` | 201 `{pageId, version}` |
| `POST /knowledge/pages/:pageId/delete` | `{expectedVersion}` | 200 `{pageId, versionsErased, searchEntriesErased, proposalsClosed}` |
| `GET /knowledge/proposals` | – | 200 `{proposals: [KnowledgeProposal]}` |
| `POST /knowledge/proposals/:proposalId/accept` | `{digest}` | 201 `{proposalId, pageId, version}` |
| `POST /knowledge/proposals/:proposalId/reject` | `{digest}` | 200 `{proposalId, status: "rejected"}` |
| `GET /knowledge/search?text=` | – | 200 `{results: [{pageId, kind, title, version, snippet}]}` (at most 20) |
| `GET /agents/:installationId/notebook` | – | 200 `{installationId, entries: [NotebookEntry]}` |
| `POST /agents/:installationId/notebook/clear` | `{}` | 200 `{installationId, cleared: true}` |

Every command takes an `Idempotency-Key`; a replay returns the recorded result with `replayed: true` and changes nothing.

- **Who.** Writing a page or its next version, and accepting or rejecting an agent's proposal, need `workspace.knowledge.approve` `{execute}` (`human_only`: a person, never an agent or a mandate, ADR-0024); deleting a page needs `{administer}`; clearing a notebook needs `workspace.notebook.write` `{administer}`. The kernel decides on the workspace resource first; the definer rechecks the session's authority under lock (the P06.T01a prelude). `may` in the pages read is for the screen only; every command decides again. No reviewed grant template issues these grants yet, so the switch stays off until one does (edge:check).
- **Read tags** (ADR-0031 item 6) are computed by the server, never sent: `workspace.knowledge.read` on each linked store (a null store before any is linked) and, for a product fact, the store's `catalog.products.read`; a version accepted from a proposal adds the proposing run's tags. A page, version, proposal, search hit or notebook entry is returned only when the viewer holds `view` on every one of its tags under live grants; otherwise it is left out of lists, counts and search, and a direct read is the same 404 as an absent record. No reply carries a tag. A notebook is cleared only by a person who may see every live entry (403 otherwise), and only at the notebook revision read before that check: an entry an agent wrote since is 409 `conflict` (`recheck_before_retry`), never erased unseen.
- **No customer data** (ADR-0031 item 2): nothing in knowledge or a notebook carries the customer tag (`support.case.read`), refused by CHECK on every table and by the agent tools.
- **Versions** are append-only, at most 1,000 per page, each a person's act (written, or a proposal accepted). A version is written at the version the person read: anything else is 409 `conflict` (recheck). One live brand-voice page per workspace (a second is 409); at most 500 live pages and 50 pending proposals.
- **Proposals** come only from an installed agent's `knowledge.propose` tool (`workspace.knowledge.propose`, an internal write that grants nothing and changes no page). An accept or reject names the digest the person saw, and an accept is refused as stale when the page moved past the version the proposal was made on: 409 `conflict` (recheck). A decision erases the proposal's text and keeps its digest; an accept makes the next version, authored by the agent and accepted by the person.
- **The deletion path** (ADR-0031 item 4): a delete, at the version read, erases the page's title, every version's text and sources, its search entry and its pending proposals' text in one transaction, and records a content-free `knowledge_deletions` row and the command. Nothing of the content can be read afterwards. A notebook clear erases every live entry. Notebook entries are clocked 90 days from their write; the retention sweep and the deletion at agent uninstall come with their own work.
- **Agents** never call these routes: the agent loop's tool-call step runs `knowledge.propose`, `notebook.write` and `knowledge.search` under the run's lease (`packages/work/src/knowledge/run-steps.ts`), behind the switch's `agent_tools` (committed `off`; it needs the routes and the agent loop on).
- Each request logs one fixed `morrow_knowledge` line (route and outcome), never page text.

## Published limits

Pages of 1–25 goals or 1–50 tasks or questions; bodies of at most 64 KiB; `successCriteria` ≤ 20; `allowedResources` ≤ 1; per workspace up to 10,000 goals, per goal 200 tasks, per task 50 open questions.
