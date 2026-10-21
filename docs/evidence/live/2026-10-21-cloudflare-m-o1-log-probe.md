# 2026-10-21 Cloudflare: M-O1 log probe passes on the deployed staging api

- **Approval.** Staging card `staging-card-1`. The probe is one request to Morrow's own staging api. The Workers Logs query is effect E9 (Workers Logs queries), run with the operator token's Workers Observability Read. P04.T01i M-O1, after the first deploy and before any real sign-in.
- **Exact action.**
  - **The probe.** At 2026-10-21T11:48:31.520Z, Claude sent `POST /auth/login?probe=<m>` with:
    - `X-Morrow-Probe: <m>`;
    - the cookie `__Host-morrow_login=<m>`;
    - the challenge token `MORROWPROBE<m>` in `X-Morrow-Challenge`.

    `<m>` was 32 random hex characters. The runner learned its own address from `<origin>/cdn-cgi/trace`. The api answered 403 `challenge_failed`: the broker's siteverify refused the token.
  - **An earlier attempt.** A first attempt a few minutes earlier (time not captured) put the token in the request body instead. It got 403 `challenge_required` and called no siteverify. It is superseded.
  - **The query.** The Workers Logs query `/workers/observability/telemetry/query` read events, all Workers, from two minutes before the probe to the query time.
- **Result.** It passed. Two events were in the window:
  - one `morrow_challenge` event with code `failed`;
  - one `morrow_broker_init`.

  Neither the marker `<m>` nor the runner's address appeared in any returned event. The runner printed only counts, booleans and event names; the marker and the address stayed in a local 0600 state file in the session scratchpad.
- **Cap and observed cost.** Within Workers Paid included log events (cost not separately observed).
- **Cleanup.** None. The probe started no login flow, because the guard refused it before any login state was created.
- **Unknown outcomes.** None.
