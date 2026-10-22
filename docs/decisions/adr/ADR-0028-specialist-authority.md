# ADR-0028 Specialist authority: run-scoped installations that the Owner starts

- Status: Proposed
- Date: 2026-10-23
- Supersedes: none.
- Amends: build-plan P16.T03, for the `task_specialist` kind only (item 5); the SQL authority layer of migrations 0030 and 0031, by forward migrations only.
- Implements: ADR-0023 decision 11 (11b, 11c, 11e, "One clock", "Switch and slip rules").
- Relies on: ADR-0027 (the spec and child runs); ADR-0025 item 7 (the Owner's `delegate` grants); ADR-0026 item 4 (cap values); ADR-0031 (retention, `dataClasses`).
- Does not change: `agent-authority.ts`; `workspace.task.delegate@1`; ADR-0005; ADR-0011.
- Terms: the Owner, as in ADR-0024.
- Unblocks: P13.T02, P05.T04, P05.T04b, P11.T04, P11.T05, P09.T05 (P13.A02, P05.A02, P05.A03); tracks T2, T4 (the specialist authority packet), T7, T12, T14, T18; gates G18 and G9's specialist classes.

## Context

The owner asked for "one main agent and then other sub agetns which can be started by user as required" (Q12) and approved decision 11: "yes to both, go with option A and specialists" (Q14). The kernel fits: `evaluateDelegation` admits one hop from the Coordinator. The SQL layer was built for Listings (0030, 0031): one scope, one live installation per store and release, and a grant issuer for Listings only. `cmd_run_admit` (0038) already creates envelope, child task, hop and reservation in one transaction.

## Decision

1. **The run-scoped installation kind.** A forward migration adds `agent_installations.kind`: `installed` (default) or `task_specialist`. A `task_specialist` row is always release `morrow.specialist`, gets a fresh agent principal at each Start, is owned by the starter and is scoped to the parent task's store (the scope CHECK becomes one rule per release). The one-per-store index is limited to `kind='installed'`. It ends `uninstalled`, never re-activated. It has no mandate, trigger, schedule or routine: the router, mentions, assignment, look-for-work and the catalogue read only installed rows, enforced in SQL.
2. **The Specialist ceiling and its SQL issuer.** The most a specialist may hold: reads of products, stock, locations, policies, pages, metrics, filtered knowledge and its own tasks; posts in its own thread, 2 questions, artifacts and suggestions; proposals for product content, SEO, tags, alt text, collections and discounts (propose only, as Listings); computer tools under the runtime switch. **Never** at launch: order reads (`orders.read`, Level 1 aggregates included), `support.*`, customer reads, `workspace.task.delegate`, task create or assign, `approve` or `execute` on a publish capability, or any `human_only` capability. A new identity-owned definer, `work_specialist_grants_issue`, holds this ceiling as a fixed allowlist and issues one grant set only for a `task_specialist` installation created in the same transaction: at most 16 ids, on its store, by its human owner, expiring with the envelope. Anything else is refused. T2 fixes the exact ids.
3. **The Start document.** Opening the card makes the server build a document binding the actor, session, spec digest, parent task revision, release, capabilities, `dataClasses` (ADR-0031 item 6), caps and deadline. It lasts 5 minutes and is consumed once, in `specialist_start_documents` (FORCE RLS). Only the asker may get one, and at launch only the Owner; anyone else gets `actor_ineligible`. It is issued only in a standalone-workspace session, never an embedded or email one. Card edits only narrow, each with a new document.
4. **The Start transaction.** One idempotent transaction; any refusal rolls back everything. It (a) consumes the document and rebuilds the spec from live facts (`stale` on a change); (b) locks the parent task and the workspace row and enforces the running limits; (c) checks that the Owner holds `agents.installation.activate` and each spec capability with its verbs and `delegate` (ADR-0025 item 7); (d) reserves the full credit cap (ADR-0026 item 4); (e) creates the principal and installation and issues its grants through item 2; (f) gives the starter `agents.installation.disable`; (g) creates the envelope (the Owner as requester and authorizer, depth 1, 1 child, 24 hours); (h) issues the Coordinator's delegate grant; (i) creates the child task, hop, run and audit record.
5. **Start replaces stage-and-activate for `task_specialist` only.** `agents.installation.activate` stays `human_only` and `review_required`, but this kind has no second reviewer, provisional revision or sample: the release and ceiling are reviewed at release, the installation lasts 24 hours or less with no trigger, every external effect still needs a digest-bound approval at the gateway, and the Owner starts it in person. Only the Start definer inserts a `task_specialist` row. Installed agents keep P16.T03.
6. **One clock, and the run lease.** Envelope, hop, installation grants and the Coordinator's delegate grant expire together at Start + 24 h. The run deadline is Start + 1 h by default and 8 h at most; the person may only shorten it, it never passes the task's due time, and waits count. Before the intersection, every tool call, replays included, checks that the child task is open, the deadline unpassed, the release unrevoked and both switches on. **Lease renewal:** an ids-only definer, `renew_specialist_run_lease`, executable only by `morrow_runtime_executor`, re-issues the run's 30-minute lease at most every 30 minutes, and at a resume after a question, while the deadline, the open child task, both switches and the starter's grants hold, re-running these checks; otherwise the run ends (new `lab:specialist-authority` cases: past the deadline, a revoked grant, a switch off). At run end the reservation settles; the installation stays `active` only for the gateway's re-check, proposals live until the earlier of their ADR-0011 limit and the envelope's end, and a sweep then marks it `uninstalled`. Every stop ends the run at once. "Run again" is a new Start.
7. **Limits.** One level: depth 1, 1 child, no delegate tool or grant. 1 running per task, 2 per workspace. No customer data: a spec's `dataClasses` never include it, and every read is filtered by the spec's `dataClasses` and the starter's read tags together. Input refs with a customer read tag, and input refs to uploads (ADR-0029 item 6), are refused at draft and at Start (new `lab:specialist-authority` cases). Workspace-level rules bind every specialist: specialists default to Ask, and a Never on any installed agent for a class binds them, at spec derivation and again at apply.
8. **Who starts, and the switches.** The Owner only at launch; Members later, by amendment. The Owner can turn specialists off per workspace (owner question 1). `docs/decisions/specialists-staging.json` is committed `"off"`: Start then answers 503 before any document, lock or reservation, and `edge:check` refuses a mixed state. It goes on by one reviewed commit after G9, G10 and a passing live eval of `morrow.specialist` on staging. Production has no switch before the production custody ADR.
9. **Deletion (G9).** Specs, Start documents and retired principals, installations, grants, envelopes and hops follow ADR-0031 item 1's rows. The deletion definer that passes the `append_only` triggers for these tables registers its handlers in ADR-0031's one registry (`redaction.ts`) and runs under the retention sweep; it is not a separate path.

## Security invariants touched

- **FORCE RLS; no client-supplied ids:** `lab:tenant-conformance`, `tenant-conformance-registry.test.mjs`.
- **The intersection, under the ceiling:** `agent-authority.test.mjs`, `lab:specialist-authority` (new), `lab:agent-authority-workers`.
- **Digest-bound approvals and Start:** `review-policy.test.mjs`, `approval-records.test.mjs`.
- **Budget checks in code:** `lab:run-credits`.
- **`human_only` kill switches:** specialists hold none (`kill-switch.test.mjs`, `stops.test.mjs`).
- **Default deny; G9 and G10:** `edge:check`, `edge-config.test.mjs`.
- **Immutable migrations:** `migration-history.test.mjs`.

## Consequences

If this record is not approved in W1, G18 is at risk; the slip rules apply unchanged. Installed agents gain only the `kind` column; Listings is unchanged.

## Alternatives considered

- **A standing specialist principal per workspace:** shares grants across runs and needs kernel edits; ADR-0023 rejected it.
- **Widening the Listings issuer:** mixes fixed and expiring sets.
- **Uninstalling at run end:** later approvals would fail the gateway's re-check.

## Owner questions

1. **The workspace setting's default once the platform switch is on:** (a) on, and the Owner may turn it off; (b) off until the Owner opts in. *Recommendation: (a);* every Start is the Owner's explicit, priced, digest-bound act.

## Approval

Pending. The owner's answer will be quoted here verbatim with its date.
