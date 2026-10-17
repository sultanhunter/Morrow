# ADR-0010 Tenant data pattern for P06+ and work API v1

- Status: Accepted
- Date: 2026-10-17
- Affects: P06.T01a (§4.1–§4.12), every table created in package 6 and later, P05.T01x (template v2), P05.T02a (issuance, harness), P01.T02a §8 (task cancel rows), P01.T02c, `docs/contracts/work-api.md`, `@morrow/contracts/work-permissions`, the plan-R1 Package 6 "Tenant data pattern"

## Context

P06.T01a adds the first work commands: goals, tasks, assignment and questions. Three choices are material under ADR-0002:
- the permission vocabulary (authority);
- the database pattern every later table copies (tenancy);
- the HTTP API (contract).

Two smaller ones have defaults: who may be assigned or asked, and whether tasks can be cancelled.

The delivered P05 identity pools use a primary plus a same-role observer per role. That costs two connections per request and does not scale to many tables. Plan R1 requires one tenant data pattern for package 6 onward and registration with the P05.T02a conformance harness.

## Decision

1. **Work permission vocabulary v1** (OQ-1; P06.T01a §4.8).
   - **Verbs.** Creates use `execute`; `propose` is kept for P11 agent proposals. The `*.create` capabilities also govern their record's transitions.
   - **Ownership.** Ownership selects the verb (own → `execute`, other → `administer`), but a grant is always required.
   - **Reads** are `view` on the capability that creates the record.
   - **Answers.** `workspace.question.answer` is `execute` by the designated respondent only; `administer` never answers for someone else.
   - **Fields.** Each route requests every non-metadata field it returns, using the §4.8 FieldPath lists. Metadata is never gated (`schemaVersion`, `id`, `organizationId`, `workspaceId`, `storeId`, `revision`, `createdAt`, `updatedAt`). An uncovered field gives 403 `field_denied`, never a partial object.
   - **Resource.** The resource is the workspace W.
   - **One module.** The table is the single module `@morrow/contracts/work-permissions`, guarded by a contract check.
   - **Issuance** is grant template v2: one grant per capability, carrying the union of its fields. New owners get it at signup once v2 exists. Existing owners get it only through P05.T02a's audited issuance (ADR-0009 item 7). Owner-SQL fixtures are used until then.
   - **Not adopted.** A separate `workspace.work.read` capability is not adopted; it is carried to P01.T02c.
2. **Tenant database pattern for P06+** (OQ-2; P06.T01a §4.1–§4.5, §4.12).
   - **Tenant keys.** Every tenant row has NOT NULL `organization_id` and `workspace_id`, plus `store_installation_id` where relevant. Primary keys start with them, and composite foreign keys make cross-tenant references, nested ResourceRefs included, unrepresentable.
   - **RLS.** ENABLE and FORCE RLS on every table. Read policies and write policies (`USING`/`WITH CHECK`) compare against `current_tenant()`.
   - **Tenant context.** `current_tenant()` re-resolves the transaction-local session digest through `session_eligibility()`. GUC values carry only that bearer-equivalent digest and never establish authority: a forged GUC yields zero rows.
   - **Roles and functions.**
     - API functions are SECURITY DEFINER, owned by a command role that is itself subject to the tenant policies.
     - Helpers and triggers are INVOKER and granted to nobody.
     - No API function takes an organization, workspace or actor parameter.
   - **Logins.** Each Worker has one NOINHERIT LOGIN with no privileges, holding a single SET-only membership (`INHERIT FALSE, SET TRUE`). That role is entered by one fixed, parameter-free `SET LOCAL ROLE` prologue with transaction timeouts. Its password is leased from the broker (ADR-0007).
     - That prologue is the only SET ROLE. It is source-fixed, never caller-controlled. This refines the plan's "no caller SQL or SET ROLE" wording for P06+.
     - P05 pools are unchanged unless a hosted p95 miss justifies a retrofit (IMP-11).
   - **Connections and reconciliation.** One connection per request, never reused. An unknown commit is reconciled by command ID, because the `commands` row commits atomically with the effect. There are no observers.
   - **Grant decisions** are made only in the `packages/policy` kernel, inside the Worker. SQL rechecks freshness (policy revision, grants digest, expiry) under an organization `FOR SHARE` lock. There is no SQL grant interpreter.
   - **Conformance.** Every object registers with `tests/tenant-conformance/`: static checks S1–S6 and probes P1–P6, the forged-context probe included. Hyperdrive and poolers are not qualified.
   - **Accepted residual risk** (§4.3). A compromised api Worker holding a live victim session could exceed that victim's grants within the victim's workspace. It cannot cross tenants or outlive a revocation. This is the P05 boundary.
3. **Work HTTP API v1** (OQ-3; P06.T01a §4.9).
   - **Contract.** `docs/contracts/work-api.md` is an internal JSON contract between the api Worker and Morrow's own SPA, not a third-party API. It covers the routes under `/workspace/:ws/work/*`, closed request bodies, server-built v1 capability inputs checked with generated validators, the v1 `ErrorEnvelope` mapping, per-actor idempotency keys, byte-identical not-found, and `uncertain` only after the command is sent.
   - **Published limits.** Pages hold 1–25 goals or 1–50 tasks; bodies are at most 64 KiB; `successCriteria` ≤ 20 and `allowedResources` ≤ 1. Each workspace holds up to 10,000 goals, each goal 200 tasks, and each task 50 open questions.
   - **Changes.** Additive changes are routine. Breaking changes need a superseding ADR.
4. **Eligible assignee and respondent** (OQ-4; §4.7 step 6). A target must be an active human member who **currently holds** a relevant grant, checked by the kernel against the target's grants:
   - assignee: `view` on `workspace.task.create`;
   - respondent: `execute` on `workspace.question.answer` plus `view` on `workspace.question.request`.

   A non-member gets 404, identical to an unknown id. A member without the grant gets 409 `target_ineligible`. Target grants are never returned.
5. **Task cancel edges** (OQ-5).
   - **Edges.** `draft→cancelled` and `ready→cancelled` exist, with actor owner, guard `no_dispatch` and the existing capability `workspace.task.cancel` (input `taskId`, `expectedRevision`).
   - **Where they land.** P01.T02a §8 adds them as v1.1 transition rows. A later P06 forward migration persists them, together with their route and a vocabulary row that follows item 1's ownership rule. P06.T01a's `tasks` CHECK stays `draft|ready`.
   - **Until then,** goals that have tasks cannot be cancelled.

## Consequences

- P06.T01a is Ready for engineering, with the mandatory Tier 2 security review. Its hard orderings are unchanged: no external effect, synthetic data only.
- The P06.T01a PR updates the plan-R1 Package 6 "Tenant data pattern" text to describe the resolver-validated context and the fixed `SET LOCAL ROLE` prologue.
- P05.T02a's harness adopts the registry and table classes. A follow-up template-v2 packet issues the work vocabulary.
- P01.T02c owns `workspace.work.read` (if ever needed) and the conversation, inbox, project and EventEnvelope@2 contracts.
- Item 2 names the per-Worker login role, so adding `morrow_api_worker` to the broker role map is covered by ADR-0007 item 2 and the edit itself is routine. Its Tier 2 review states whether R1 or R2 widens.

## Approval

Owner approval, 2026-10-17, in chat (second batch). The owner selected **"Accept recommended (Recommended)"** for this question:

> Work tasks (P06.T01a): creating goals, tasks and questions needs 'execute' permission; reading needs 'view'. Assignees and question respondents must currently hold a relevant permission, not just be members. Internal JSON API under /workspace/:id/work/*. One shared tenant-isolation database pattern for every new table. Tasks can be cancelled from draft/ready. Accept?

This accepts the recommended answers to P06.T01a OQ-1 through OQ-5.

The question's summary did not mention four parts of those answers: the ownership rule in item 1 (own → `execute`, other → `administer`); the fixed `SET LOCAL ROLE` prologue in item 2, which refines the plan's "no caller SQL or SET ROLE" wording; the accepted residual risk in item 2 (§4.3); and the published limits in item 3. They are the recommended OQ-1 to OQ-3 answers as written in the packet.
