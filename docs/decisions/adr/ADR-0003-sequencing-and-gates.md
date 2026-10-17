# ADR-0003 Two-track sequencing, P02 gate split, golden path and P05.T01w deferral

- Status: Accepted
- Date: 2026-10-17
- Supersedes:
  - the use of the dependency table as a start gate;
  - the AGENTS.md line "P02 interaction baseline before feature UI";
  - the plan wording that holds feature UI until P02 participant qualification;
  - the sequence-95 packet "P05.T01w Genuine Firefox transport prerequisite".

## Context

**The P05.T01w packet.** Sequence 95 of the old Page opened P05.T01w. It is test-only: it proves `__Host-` cookie handling in a genuine Firefox, running in a Playwright container against a synthetic NSS root. It changes no product behaviour. The previous agent had begun it in its private working copy and never committed it.

**What already exists.** After 11 days of work, the product had no usable screen: `apps/workspace-web` renders a placeholder. It had no signup. It had no work, task or agent code. The plan's dependency table (build-plan.md, "Dependency graph") calls itself "qualification prerequisites; drafting can begin earlier". In practice, it was read as a start gate.

## Decision

**1. Two-track rule.**
- Local engineering of any package may start once the interfaces it consumes have been reviewed, using real local PostgreSQL 17 and workerd.
- The dependency table gates qualification, Verified status and activation. It does not gate when work starts.

**2. Hard orderings that remain.**
- (a) No agent-initiated external effect before the P11 gateway, budget reservations and stop controls exist.
- (b) No real merchant data of a given class before its P09.T05 privacy and deletion path exists.

**3. The P02 gate is split.**
- Feature UI may be built provisionally on the selected option-1 candidate (`docs/design/tokens.json`, `component-baseline.md`, `prototype.html`), ported into `packages/workspace-ui`.
- P02.A04 participant qualification is still required. It must pass on the integrated M2–M4 slices before any merchant pilot, and before any feature UI is marked Verified.
- Every UI slice gets automated accessibility, keyboard and contrast checks at 1440, 768, 390 and 320 px.

**4. Golden path milestones.** M1–M5 map to the plan's internal demonstrations:
- M1: hosted sign-in reaches a workspace.
- M2: two differently scoped people collaborate on one task.
- M3: a development-store install with a synced catalog.
- M4: an AI-free exact product change: proposal → approval → gateway → readback → audit.
- M5: the Coordinator investigates, drafts, asks, waits durably and recovers.

**5. Hardening budget.** At most two consecutive lettered children on one subsystem may land without an observable product delta. More are allowed only if an ADR names the specific threat being retired.

**6. P05.T01w is deferred.** A real-browser Playwright login → bootstrap → logout smoke test replaces it. That test runs against the hosted staging origin as part of P04.T01i (M1), which proves `__Host-`/Secure/SameSite cookie behaviour on a real HTTPS origin. Transport, capsule and pool hardening of the P05 login stack is frozen. The remaining P05 work is product lifecycle:
- P05.T01x: first-owner signup and workspace list.
- P05.T01y: session lifecycle.
- P05.T01z: invitations and membership.
- P05.T01aa: enterprise teams, service identities, SSO and SCIM.
- P05.T02a: grant lifecycle and tenant conformance harness.
- P05.T04b: persisted agent authority.

**7. Engineering-start edges (two-track only).** The dependency table now has two columns, "engineering may start on" and "qualification inputs". The qualification inputs are unchanged from the sequence-94 plan. Engineering may start as follows:
- P08 starts on P06 plus the P07.T01 ArtifactRef contract.
- P11.T01–T03 start on reviewed P06, P08 and P09 interfaces plus the P01 source-authority rules.
- P12 is grouped into two parts:
  - P12a (trusted): P12.T03 and P12.T04, plus the P12.T01 port and lease interfaces.
  - P12b (isolated): P12.T01 profile qualification, P12.T02 and P12.T05.
- P13 engineering starts on P10.T01, P11 and P12a. Code and browser tools stay hard-denied until P12b qualifies.
- P14 slices start on the APIs they consume.

Narrowing any qualification input needs a separate owner-approved ADR. One example is P11's dependency on P10, which could be limited to proposals that originate from context or agents.

## Consequences

- Backend, UI and identity lifecycle work proceed in parallel.
- Human-facing acceptance and the pilot remain gated on the usability study, so the study must be scheduled. The recruitment path and the designated reviewer are pending owner decisions.

## Approval

Owner approval, 2026-10-17, in chat:
- **"Two-track + provisional UI (Recommended)"**: local engineering of later packages starts now. The dependency table and the P02 usability study gate qualification, Verified status and any merchant pilot. The hard orderings are kept.
- **"Defer; test on staging (Recommended)"**: P05.T01w is replaced by a real-browser login smoke test against the hosted staging site in M1.
