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
| Database unavailable before the command was sent | 503 | unavailable / recheck_before_retry (reads: safe_read_retry) |
| Command or COMMIT sent, reply lost | 503 | uncertain / reconcile_before_retry |

## Agents routes (M3 PR-1)

An internal JSON contract beside the work API, under `/workspace/:ws` (not `/work`), on the same api Worker, dependencies and guard rules (`packages/work/src/agents/http.ts`; ADR-0022 items 3, 15 and 16, with the item 3 amendment of 2026-10-20). `PUT` follows the `POST` rules: exact `Origin`, Fetch Metadata, `X-Morrow-Request: 1`, `Content-Type: application/json` and an `Idempotency-Key`. Bodies are closed and never carry a tenant, store connection, installation or actor value: the store comes from the path and is resolved against its current association. Every command runs the human kernel on the exact resource first, then its definer, which rechecks authority under lock. An unbound api answers 401 with no network or database access.

| Route under `/workspace/:ws` | Body | Success |
| --- | --- | --- |
| `GET /stores/:storeId/agents/listings` | – | 200 `{storeId, linked, blocked, installation: {installationId, status, revision, stopped, updatedAt} \| null, actions: {enable, resume, stop}}` |
| `POST /stores/:storeId/agents/listings/document` | `{}` | 201 `{documentId, documentDigest, installationId, purpose: "enable" \| "resume", expiresAt, document, nonce}` |
| `POST /stores/:storeId/agents/listings` | `{documentDigest, nonce}` | 200 `{installationId, revision, status: "active", purpose, documentDigest}` |
| `POST /stores/:storeId/agents/listings/stop` | `{control: {reason, sourceProposalRef: null}}` | 200 `{status: "disabled", killSwitchRecordId, priorStateObserved, stopId, installationId, revision, pendingOperations: []}` |
| `GET /models` | – | 200 `{catalogueVersion, entries: [{model, effort, creditsPerProduct, runProductLimit, allowedForMember}], workspaceDefault: {model, effort}, ceiling, revision, canRevise}` |
| `PUT /settings/model-default` | `governance.model_default.revise` input `{model, effort, maxCreditsPerProduct, expectedRevision}` | 200 `{revision, model, effort, maxCreditsPerProduct}` (the recorded result; a replay returns the same body with `replayed: true`) |

- **Enable and resume** (the confirm screen). Step 1 needs `agents.installation.activate` `{execute}` on the store resource, with fields `grant` and `installationId`, and every verb the installation receives (`catalog.products.read` view, `catalog.content.propose` execute, `catalog.content.publish` propose, on the store and the listing fields). The server builds the installation document: the release `morrow.listings` v1 and its digest, the store resource, the installation id, the exact grant set and the owner's `agents.installation.disable` grant. It binds the document to the actor and the session for five minutes and returns its single-use `nonce` once; only the nonce's digest is stored. Step 2 reruns the kernel against current authority and sends the document's digest and nonce. Under the organization interlock, the definer checks the actor, session, expiry, nonce, release, store connection, platform and connection stops and the installation state against the document, then creates the installation's and the workspace Coordinator's agent principals, issues the three grants (each exactly the document's, through the identity bridge's allowlist) and the owner's disable grant, and consumes the document. `resume` is offered only after the owner's own "Stop AI work" (a person's installation stop with its KillSwitchRecord), and only when the installation is exactly what its document names: the release digest, the store resource with its connection, and the grant set (the installation's stored grants, unrevoked and unexpired, each equal to the document's). Both steps compare them, in the Worker and in the definers, and any difference is 409 conflict (state); such an installation is uninstalled and enabled afresh. The resume document records the stop open when it was built; the confirmation lifts only that stop, as a person, and reactivates the installation, so a stop set after the document was built stays (409 conflict). Platform and connection stops are lifted only through their own paths: a resume under one is 409 conflict and changes nothing. A wrong, expired, reused or another session's document is 409 conflict (guard); another actor's document is not this actor's to read, so the Worker answers 404 (the definer, called directly, refuses it as guard). An existing installation is 409 conflict (state).
- **Stop AI work** needs `agents.installation.disable` `{execute}` on the installation resource (fields `control`, `installationId`). `checkKillSwitchTarget` accepts the target, and the KillSwitchRecord commits with the installation stop, which revokes its run and operation leases, and with `kill_switch.executed`. Stopping again records `already_stopped`. The record's `priorStateObserved` is the Worker's read; if another stop committed before the definer's lock, the request is 409 conflict (recheck), and a retry records `already_stopped`. `blocked` in the status read is true while a platform stop or a stop on the store's connection is open: no AI work runs although the installation may be active. It never reads entitlement or credits, and it works whether or not the store's association is current.
- **Models.** Any current member may read `GET /models`. It names opaque catalogue keys only, never a provider model string, price, cost or token limit. `allowedForMember` applies the member ceiling unless the reader holds `governance.model_default.revise`. `PUT` needs that capability. It accepts only keys of the active catalogue version and a ceiling (1–99) that admits the default. `expectedRevision` is null for the first row; anything else stale is 409 conflict.

## Runs routes (M3 PR-2)

An internal JSON contract beside the work API, under `/workspace/:ws/work`, on the same api Worker, dependencies and guard rules (`packages/work/src/runs/http.ts`; ADR-0022 items 2, 3, 9-11 and 16). The api's dispatch table sends exactly these paths to it, ahead of the work API's row. Bodies are closed: admission names a store id, product ids, listing field paths and opaque catalogue keys, never a tenant, installation, actor, provider, price or credit amount. An unbound api answers 401 with no network or database access.

| Route under `/workspace/:ws/work` | Body | Success |
| --- | --- | --- |
| `POST /tasks/:taskId/runs` | `{storeId, products: [product:<n>] (1-25 distinct), fields: [field paths] (1-5, both SEO fields or neither), selection: {model, effort} \| null}` | 201 `{runId, status: "queued", childTaskId, productCount, creditsReserved, catalogueVersion, selection: {model, effort}}` (a replay returns the same body with `replayed: true`) |
| `GET /tasks/:taskId/runs` | – | 200 `{runs: [run]}` (newest first, at most 20) |
| `GET /runs/:runId` | – | 200 `{run, credits: {reserved, settled, status}, usage: {attempts, inputTokens, outputTokens}, products: [{index, productId, status, attempts, failureCode, proposalId, flags}], interrupted}` |
| `POST /runs-reconcile` | `{}` | 200 `{closed}`, the actor's own runs closed (a replay returns the same body with `replayed: true`) |

A `run` is `{runId, revision, taskId, childTaskId, storeId, status, endedReason, selection, catalogueVersion, creditsPerProduct, productCount, fields, productsDrafted, productsFailed, createdAt, startedAt, endedAt, updatedAt}`. `flags` are the reviewer flags as counts (`newUrls`, `newEmails`, `newPhones`, `tagsAdded`, `tagsRemoved`). No read returns a draft's text, a product as read, a provider request or model id, a raw stop reason or a per-call cost.

- **Admission.** While the model-provider switch is off (`MORROW_MODEL_PROVIDER` absent), admission is 503 unavailable (`recheck_before_retry`, "AI drafting is not available yet.") before any database access. Otherwise, in one transaction: the parent task is the actor's own and draft or ready; the store's association is current and its Listings installation active; the human kernel allows `execute` on `catalog.content.propose`, `view` on `catalog.products.read`, `delegate` on both, and `propose` and `delegate` on `catalog.content.publish`, on the store resource and the fields; entitlement through `entitlementFor` over M5's billing facts and a billing period exist; the selection resolves against the active catalogue within the member ceiling (`governance.model_default.revise` exempts; null is the workspace default); the products fit the selection's run limit. The code Coordinator writes CoordinatorRoute@1. `cmd_run_admit` rechecks every data rule under the P06.T01a prelude, derives the billing account, entitlement, period and cost allocation in SQL, closes the workspace's stale runs, reserves credits and vendor cost, opens the run lease and creates child task T′ (ready, owned by the requester), the envelope, the Coordinator's 24-hour `workspace.task.delegate` grant on T, the hop, the run, its products and manifest, and `task.created`, `task.status_changed` and `run.admitted`. The orchestrator's cron starts the run from `pending_starts()`.
- **Refusals** persist nothing. Not entitled, or no billing period: 403 denied ("An active Morrow plan is required to draft listings."). Not enough credits, the daily cap, the unrecovered-cost cap, or more products than the selection allows: 409 `budget_exhausted` / never. An unknown or retired selection: 400 missing_input. A selection above the member ceiling: 403 denied. A stopped store, or no active Listings installation: 409 conflict / never. A foreign or absent task or store: 404.
- **Reads** are gated as every work read (P06.T01a §4.7): `view` on `task.read` first (a run belongs to its task, whose read lists `activeRunId`), so a single run the actor may not view is 404, identical to an absent one, and a task's runs are 403; then `view` on `catalog.products.read` on the run's own store resource with the run's fields, so a run on a store the actor may not read is 404 and is left out of a task's runs.
- **Reconcile** needs `view` on `task.read` (403 denied otherwise) and closes the actor's own interrupted runs; another member's interrupted run closes at the next admission in the workspace. An interrupted run is one still queued or running whose lease a stop revoked or which outlived its 30-minute lease. Its open model calls are booked as uncertain at their worst case, products in progress fail as `interrupted` and their cost accrues as unrecovered, the credits settle at the products proposed (the rest returns), and the run moves to `cancelled` through the `work_service` edges, with `endedReason` `stopped` or `lease_ended`. `interrupted` in the run read says the close applies.

## Published limits

Pages of 1–25 goals or 1–50 tasks or questions; bodies of at most 64 KiB; `successCriteria` ≤ 20; `allowedResources` ≤ 1; per workspace up to 10,000 goals, per goal 200 tasks, per task 50 open questions.
