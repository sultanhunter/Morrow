# ADR-0009 Self-serve enrollment and first-owner signup

- Status: Accepted
- Date: 2026-10-17
- Affects: P05.T01x Part B (§2, §3, §5, §6, §8, §9, §11), P05.T01z, P05.T02a, P01.T02a (`WorkspaceOwnershipFacts`), P14.T01a, P04.T01i, P09.T05, the plan-R1 P05.T01x bullet, `docs/decisions/data-lifecycle.md`, `docs/contracts/identity-authority.md`

## Context

Today the owner seeds every principal, mapping, organization, membership and grant with SQL, and `POST /auth/login` requires a workspace id before sign-in. Plan R1 asks P05.T01x for self-service signup "in one definer transaction".

The packet splits this into enrollment and signup instead, for four reasons:
- there is one bearer type;
- invitations (P05.T01z) need a principal before acceptance;
- a lost callback commit must reconcile at the next sign-in;
- a new principal must have no authority.

Part A of P05.T01x (migration 0012, the plan-number identifier rename) is routine and is not covered here.

## Decision

1. **Enrollment at the first verified sign-in** (P05.T01x §2, §6 `admit_account_family`).
   - The inputs are signature-verified evidence only: subject, provider session and profile tuple. No email is read, stored or matched.
   - The principal, mapping and profile binding are created together, in the admission transaction, only for an unmapped `(provider, environment, subject)` while enrollment is enabled. Enrollment confers **no tenant authority**: no organization, membership or grant.
   - An existing mapping needs an existing active binding to the signing profile. It is never extended to another WorkOS application or client. Revoked or inactive records are never reactivated.
   - A lost callback commit reconciles at the next sign-in through `UNIQUE (provider, environment, subject)`.
2. **Signup is a separate human-initiated command** (§3.3).
   - `POST /organizations` can be called only by a browser session family. The fixed definer executes exactly that person's request.
   - It therefore satisfies ADR-0005 `human_only` and is not an exception to it.
   - `issuedBy {kind:"service", principalId:"morrow.onboarding"}` is a provenance tag naming the template, not a deciding actor.
   - Signup is the only grant path that bypasses ReviewPolicy, limited to one fixed template, once per principal.
   - The P05.T02a harness accepts a `service` issuer only for `morrow.onboarding` with a matching `organization_signups` row. P05.T02a revokes these grants like any other, and ADR-0011 reviewer eligibility counts them as ordinary current grants.
3. **Owner definition** (§3.2).
   - The owner of an organization is the principal of its `organization_signups` row, while that principal's organization membership is active. Being owner confers no authority: the kernel reads only grants.
   - P05.T01z adds transferable owner designations seeded from this record, plus last-owner protection.
   - ADR-0005 owner notifications read the same source.
   - The ADR-0011 solo-owner rule uses this owner as the designated owner, supplied through `WorkspaceOwnershipFacts`.
4. **Dedicated executor** (§3.7).
   - `morrow_identity_onboarding` is NOLOGIN at migration, NOINHERIT and has no memberships. It holds EXECUTE only on `create_first_organization`, whose definer checks `session_user`.
   - `morrow_api` stays read-only and gains only `account_overview`.
   - Login wiring drops `morrow_identity_resolution`, so the broker role map stays at seven roles. The password arrives only through a broker lease (ADR-0007).
5. **Account API contract** (§1, §8, §9), additive in contract v1.1, or v1.2 if v1.1 is frozen at merge.
   - **Endpoints.** `POST /auth/login {"schemaVersion":2}` takes no workspace. `GET /workspaces` lists at most 100 workspaces, filtered by `session_eligibility` in one snapshot, plus `onboarding`. `POST /organizations` takes a lowercase-UUID `Idempotency-Key` and the closed body `{schemaVersion, organizationName, workspaceName}`.
   - **Outcomes.** They follow the fixed §9 outcome→HTTP table. `outcome_unknown` is returned only after `markSubmitted()`, and a same-key retry is the reconciliation.
   - **Headers.** Responses never `Set-Cookie`. The request guard follows invariant 22.
   - **Contract additions.** The route `account` (`/`) and the schemas `AccountOverview`, `OrganizationSignupRequest` and `OrganizationSignupResult`.
6. **Retention and erasure hooks** (§3.5).
   - `account_enrollments`, `account_session_commands`, `organization_signups` and `self_service_revisions` are append-only, with the classes and retention in the §3.5 table.
   - Their trigger function `account_preserve_record()` is the replaceable hook. P09.T05 replaces it in a forward migration, so a dedicated privacy-maintenance role can erase or pseudonymize rows.
7. **Grant template v1 `owner-bootstrap-v1`: governance only** (§3.4).
   - **Scope.** Every grant is workspace-scoped to the new workspace W, with no store or account.
   - **Capabilities.** `governance.membership.invite`, `governance.membership.revoke`, `governance.grants.revise`, `governance.connection.connect`, `governance.connection.disconnect`, `governance.approval.decide`, `governance.usage.read` and `governance.approval.preview`.
   - **Verbs.** `read` → `view`. `governance.approval.decide` → `approve` (the ADR-0011 reviewer verb). `connection.connect` → `administer` plus `approve`. Other control capabilities → `execute` plus `approve`. Fields are the effective input property names.
   - **Not in v1.** Work-task permissions (the ADR-0010 vocabulary) and `governance.review_policy.revise` come in a follow-up template (v2), issued at signup only after it exists and to existing owners only through P05.T02a's audited issuance. v1 rows are never rewritten.
   - **Pre-install billing.** No template capability has a spend or billable effect, so ADR-0006 holds.
8. **Limits** (§11).
   - **Rate windows**, all enforced now:
     - enrollment per profile: 30 per 10 minutes and 500 per 24 hours;
     - signup per profile: 20 per 10 minutes and 200 per 24 hours;
     - login start: 10 per 10 s and 100 open.
   - **Launch.** Turnstile bot protection and an edge per-IP limiter are required before sign-up opens beyond the allowlist (item 10). They are injected as optional dependencies and may arrive earlier with hosted activation. No IP address is stored.
   - **Accepted risk.** The per-profile windows are global lock-out levers.
9. **One organization per principal.** Each principal (one WorkOS subject) can create one organization through signup. For now, membership of further organizations comes only through invitations (P05.T01z); more self-service organizations need a later reviewed capability.
10. **Eligibility (Q4b) and hosted enablement (Q5)** (§3.1, §3.6).
    - **Eligibility.** A principal may sign up only if it self-enrolled (an `account_enrollments` row) and has no `organization_signups` row. Owner-seeded principals are never eligible. Invited principals (P05.T01z) enroll at their first sign-in and may each create one organization.
    - **Switch.** Self-service is an append-only, audited switch (`self_service_revisions`). No row means disabled.
    - **Where it is enabled.** Revisions are enabled only on development and staging profiles. On staging, WorkOS sign-up is allowlisted to the owner's accounts until P09.T05's deletion path covers principal, mapping and enrollment (ADR-0003 hard ordering (b)). Any hosted development environment follows the same allowlist. Production enablement needs its own ADR.
11. **Verified email.** WorkOS email verification must be enabled before any environment's switch is enabled, because WorkOS may link sign-in methods by email upstream. Enrollment and signup still never read email, and token claims (`email`, `org_id`, `roles`, `permissions`) never select or create anything. This ADR does not decide whether invitation acceptance (P05.T01z) also checks a matching verified email, as plan R1 describes; email never establishes authority on its own.
12. **Plan amendments** (a)–(e) of P05.T01x §2 are approved and applied in the Part B PR.

## Consequences

- P05.T01x Part B may start. Its merge needs P01.T02a PR-A (generator, catalogue bodies) and PR-B (`governance.approval.preview`, ADR-0011 Q5).
- P05.T01z builds on the owner record and supplies `WorkspaceOwnershipFacts`. P05.T02a registers the new tables and routes and enforces the `morrow.onboarding` issuer exception. P14.T01a builds the onboarding UI.
- Real-user signup stays closed: development and staging allowlist only, with no production enablement.

## Approval

Owner approval, 2026-10-17, in chat (second batch). The owner selected **"Accept recommended (Recommended)"** for this question:

> Self-serve signup (P05.T01x): each person can create one organization through signup (more only via invitations for now). Requires a verified email. On staging, signup is allowlisted to you until the privacy/deletion path exists. The new owner gets governance permissions now; work-task permissions come in a follow-up grant template. Rate limits now; bot protection (Turnstile) and per-IP limits at launch. Accept?

The recommended answers accepted are P05.T01x Q1 (this ADR's content and the plan amendments), Q2 (template v1), Q3 (limits), Q4 (one organization), Q4b (eligibility) and Q5 (hosted enablement).

The question's summary did not spell out items 1–6, the eligibility rule in item 10 or item 12. They are the recommended answers to Q1 and Q4b as written in the packet, including that signup is the only grant path that bypasses ReviewPolicy (item 2).

Item 7 records two template alignments that follow from ADR-0011, approved in the same batch: `approve` on `governance.approval.decide`, and `view` on `governance.approval.preview`.

## Notes

- 2026-10-18: ADR-0015 supersedes ADR-0006. Item 7's "Pre-install billing" point now reads as ADR-0015's pre-payment state. It still holds, because no template capability has a spend or billable effect.
