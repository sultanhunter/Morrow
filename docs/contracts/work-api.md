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

## Published limits

Pages of 1–25 goals or 1–50 tasks or questions; bodies of at most 64 KiB; `successCriteria` ≤ 20; `allowedResources` ≤ 1; per workspace up to 10,000 goals, per goal 200 tasks, per task 50 open questions.
