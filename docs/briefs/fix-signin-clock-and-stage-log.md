# Sign-in fix: cross-clock bounds and the callback stage line

- Status: built, 2026-10-24. Branch `claude/fix-signin-clock-and-stage-log`. Change class: a routine fix with tests (ADR-0002). No change to authority, to the database's own limits, to the 1800-second cookie cap or the 12-hour family cap, or to any contract, migration, secret or route. The review uses the security lens because this is sign-in.

## Goal

The owner's first live sign-in failed every time with "Sign-in could not be completed" after the WorkOS callback. The admission transaction ran, but nothing committed. The leading cause was the admission decoder. It compared the database's `clock_timestamp() + 30 minutes` with the Worker's `Date.now() + 30 minutes` with zero tolerance. So whenever the database clock led the Worker's by more than the reply latency, the Worker refused the reply and rolled back. The labs share one clock and never hit this. The goal is to make sign-in work on real clocks and to make the next failure name its own step.

## Scope

1. **Admission decode** (`workos-browser-session-admission.ts`). A `newly_admitted` reply's expiry must be after the Worker's `at` and before `min(evidence lease end, at + 5000) + 1800000`. That is the SQL's own guarantee: `browser_new_lifetimes` sets expiry = n + 30 minutes, and both admit functions admit only while `p_evidence_expires > n`. The bound is capped at 5 s past `at + 30 minutes`. Only an `admit()` that carries its evidence lease can accept a new generation. `reconcile()` never can.
2. **Cross-clock sweep** of the sign-in and session paths. The shared allowance is `CROSS_CLOCK_ALLOWANCE_MS = 5000` (`packages/identity/src/clock-allowance.ts`). It applies only where another clock may lead the Worker's. It never lengthens a lifetime, so expiry checks stay exact.
3. **Stage line.** A failed callback emits exactly one line: `{"event":"morrow_login_callback_failed","stage":…,"sub":…,"lead":…}`. A successful callback and every start emit none.
4. **Request URL in Workers Logs.** Researched below. No configuration exists for it, so the risk and its mitigation are recorded here.

### Sweep: changed

| Where | Clocks | Was | Now |
| --- | --- | --- | --- |
| Admission decode | database expiry vs Worker `at` | `expiry > at + 1800000` held | the SQL bound above (item 1) |
| `workos-session-status.ts` `session()` | WorkOS `updated_at` vs Worker `now` | `updated_at > now` held the whole observation | `updated_at > now + 5000` holds. A session the exchange has just touched carries WorkOS's instant |
| `standalone-session-rotation.ts` | database idle and absolute expiry vs Worker `at` | over 12 h remaining was 503 `rotation_outcome_unknown` | up to 5 s past 12 h reads as 12 h; beyond that, unchanged. A rotate in a generation's first 60 s answers `current` with the family's `created + 12 h`, which a database lead put past the bound |

### Sweep: deliberately left

- **Token checks** (`workos-session-token.ts`). `iat` and `nbf` already allow 30 s. `exp` against now is a lifetime end.
- **Session expiry** (`workos-session-status.ts`). `expires_at <= now` and the target's expiry capping the observation lease are lifetime ends.
- **Evidence** (`workos-authentication-evidence.ts`). The token `exp` is a lifetime end. The keyset and observation leases are on the Worker's own clock.
- **Callback.**
  - Eligibility compares `database_now_ms` with the flow's database expiry, both from one clock.
  - `attempt.cap(flow expiry)` and the start cookie (`min(300, …)`) only shorten the Worker's window, and the database rechecks.
  - The session cookie is `min(1800, …)`, so a lead still gives 1800.
- **Flow custody** (`login-flow-custody.ts`). The flow expiry against the Worker's clock is a lifetime end. The flow lives 300 s.
- **Admission after commit.** `at >= expiresAtMs` is a lifetime end.
- **Capsule key** (`managed-login-capsule.ts` `coveredExpiry`). It compares the database's flow expiry with a configured key instant, not with a clock. A key rotation keeps its own margin.
- **Broker credential leases** (WorkOS port, Neon login pool). They are lease ends from the broker Worker.
- **Bootstrap, the request guard and logout.** They read no time from the database or the provider; the database decides with its own clock.
- **Session keeper.** It works in relative remaining times only.

### The stage line

- **`stage`** marks the step about to run in `callback()`. The values are `setup` (before the callback: configuration, keyring and pools), `input`, `claim`, `capsule_open`, `preauth_admit`, `eligible_before_exchange`, `exchange`, `eligible_after_exchange`, `jwks`, `verify_token`, `observe_session`, `evidence_read`, `admission` and `finalize`. `finalize` means the database admitted the session, so its rows committed.
- **`sub`** is set at the `admission` stage only. It is `admit()`'s closed held reason, reported through `onHeld`: `prepare`, `connect`, `session_setup`, `role`, `admit_query`, `decode_shape`, `decode_lifetime`, `denied`, `conflict`, `commit`, `release` or `deadline`. It is null when the callback's own deadline ended the wait first.
- **`lead`** is set for `decode_lifetime` only. It is a coarse bucket, never the value: `expired`, `lead_le_1s`, `lead_le_5s`, `lead_le_60s` or `lead_gt_60s`.
- **Closed values.** `loginCallbackFailureLine` checks every value against its closed set when it builds the line. A hostile or unknown value becomes `setup` or null. The line never changes the outcome: a throw is swallowed.

## Interfaces touched

- Source: `packages/identity/src/{clock-allowance,workos-browser-session-admission,workos-session-status,standalone-session-rotation,standalone-login}.ts`. The new exports are `browserSessionAdmissionHeldCodes`, `browserSessionAdmissionLifetimeLeads`, `loginCallbackStages` and `loginCallbackFailureLine`, plus the optional `onHeld` dependency.
- Labs: `scripts/workos-browser-session-admission-workers-lab.mjs`, `scripts/workos-session-status-workers-lab.mjs`.
- Docs: `docs/acceptance/P05.md` (AC30), `docs/packets/P05.T01y.md` (AC30 note).
- Unchanged: `apps/api/wrangler.jsonc`.

## Security notes

- **No limit is widened.** The database still enforces 30 minutes per generation and 12 hours per family. The cookie cap stays 1800 s, and an accepted expiry is never more than 5 s past the Worker's `now + 30 minutes`. The allowance applies only where another clock may lead the Worker's.
- **What the line carries.** The stage line holds closed values only. Tests feed it codes, tokens, identifiers and error text and check that none appears.
- **Request URL in Workers Logs.** Cloudflare attaches the request URL to each log event (`$metadata.url`, "Request URL that triggered the Worker invocation", Workers Observability API). On the callback, that URL holds the one-time `code` and `state`.
  - Workers Logs offers `enabled`, `head_sampling_rate`, `invocation_logs` and `persist`. No documented setting excludes or redacts the URL or its query. On staging, which is v1 production under ADR-0035, `invocation_logs` is already `false`. Development and production keep observability off. `edge:check` pins both (`edgeStagingObservability`).
  - The only configuration that removes the URL from callback lines is turning off Workers Logs for the api, which also removes the diagnostics this fix adds. That is an owner decision; it is not made here.
  - The stage line adds one event to the six that a callback already logs, so the exposure barely grows.
- **Mitigation already in place.** The code is PKCE-bound, and the public-client exchange needs the `code_verifier`. That verifier exists only inside the sealed login capsule, which is AES-GCM under the Worker keyring and erased when the flow is claimed. The flow claims a code once, by digest. WorkOS consumes a code on exchange. `state` is useless without the `__Host-morrow_login` cookie. Workers Logs is readable only by members of the Cloudflare account.
- **Possible follow-ups** (owner choice):
  - Emit diagnostics from a fixed-URL service-binding hop.
  - Use a provider response mode that keeps the code out of the URL, if WorkOS supports one.

## Test checklist

- [x] `tests/workos-browser-session-admission.test.mjs`: AC30 boundaries, as revised on the P05 row; one closed held reason per held `admit()`, none on success or on `reconcile()`; buckets; a throwing `onHeld` changes nothing.
- [x] `tests/workos-session-status.test.mjs`: `updated_at` up to 5 s ahead is observed (also as another session's `created_at`); 5001 ms is held.
- [x] `tests/standalone-session-rotation.test.mjs`: a lead of 1, 1000 or 5000 ms reads as 12 h on `rotated` and `current`; 5001 ms and 60 s give 503 unknown with no cookie; the idle bound behaves the same.
- [x] `tests/standalone-login.test.mjs`: one closed line per failed stage (input, claim, capsule_open, preauth_admit, both eligibility checks, exchange, jwks, verify_token, observe_session, the admission subs connect, session_setup, role, admit_query, commit, release and decode_lifetime with its bucket, and finalize); no request, token, id, number or error text reaches the line; success and start emit nothing; an aborted callback emits one line and delivers nothing; hostile inputs to the line builder stay closed; a database lead of up to 4.999 s signs in with `Max-Age=1800`.
- [x] Labs: the AC30 case in `lab:browser-session-admission-workers`, and in `lab:workos-session-status-workers` `future_update` now at 5001 ms plus a new 5000 ms observed case.
- [ ] `evidence_read` has no direct test; there is no hook between `verify()` and `readEvidence()`.
- [ ] Hosted CI on the PR head; one AI review (separate context, same model family) with the security lens.
- [ ] After deploy: the owner signs in once. If it still fails, read the `morrow_login_callback_failed` line from Workers Logs.
