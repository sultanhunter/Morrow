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

## Catalogue routes (M2 PR-3)

Two reads of a linked store's catalogue for the Ask screen's picker, under `/workspace/:ws` on the same api Worker, dependencies and guard rules (`packages/work/src/catalog/http.ts`; spine §4; the M2 brief's api routes). They take only their own query parameters, with closed values: `after` is an opaque cursor of at most 1,536 base64 characters (Shopify's title-sorted cursors hold the last title; these routes accept a URL of up to 6,144 characters to carry one percent-encoded, where other routes keep 512 a value and 2,048 a URL); `collectionId` is `collection:<digits>`; `query` is at most 64 letters, digits and single spaces. Anything else is 400 before any SQL or Shopify call.

| Route under `/workspace/:ws` | Query | Success |
| --- | --- | --- |
| `GET /stores/:storeId/catalog/collections` | `after` | 200 `{schemaVersion: 1, collections: [{id, title}], nextCursor, storeId}` |
| `GET /stores/:storeId/catalog/products` | `after`, `collectionId`, `query` | 200 `{schemaVersion: 1, products: [{id, title, status}], nextCursor, storeId}` |

- One READ WRITE transaction: the session's authority, the store's current association, then the human kernel must allow `view` on `catalog.products.read` on the store resource with the listing fields (403 otherwise), then `morrow_work.catalog_read_lease` opens a 60-second `read` lease for the session's tenant and actor (409 conflict under a connection stop; 404 when the store has no current connection). The lease selects the tenant of the one read; it grants nothing.
- After COMMIT, one `ApiBroker.shopifyRead` under that lease. The broker resolves the lease, its stops, the store connection and the credential itself, runs one fixed Admin GraphQL document with variables it builds (a title search becomes `title:<word>*` terms) and returns ids (`collection:<n>`, `product:<n>`), titles and a lower-case product status only. A missing collection is 404. A refused, failed or throttled-past-budget read, or one held because the broker's read slots are busy, is 503 unavailable / safe_read_retry. Page size is 25. The whole request has a 9-second deadline; the read gets whatever the transaction leaves of it less 250 ms, never more than the protocol's 15-second budget.
- Shopify's reply, the token and any provider text never reach the response or a log; each request logs one fixed `morrow_catalog` line (route and outcome).

## Published limits

Pages of 1–25 goals or 1–50 tasks or questions; bodies of at most 64 KiB; `successCriteria` ≤ 20; `allowedResources` ≤ 1; per workspace up to 10,000 goals, per goal 200 tasks, per task 50 open questions.
