# 2026-10-21 Cloudflare: flag on, and the placement deploy passes every smoke check

- **Approval.**
  - The owner wrote in chat on 2026-10-21: "set the flag, and lets skip the strip production integration for now …".
  - Staging card `staging-card-1`: E12 (`unkill`, only while the card is active), E10 (`STAGING_DEPLOY_ENABLED`) and E1 (a deploy from `origin/main` with a green `foundation`).
- **Exact actions.**
  - **15:30:27Z: `npm run staging:unkill`.** It reported `workersDev` enabled (already on), health ready after 1 poll, the deploy workflow active and the flag at `1`.
  - **Then `npm run staging:deploy` (local mode)** from the main checkout, clean at `0083b4b` (#35). `foundation` was green on it (push run 39600968875). The deployed code includes M2 PR-2 (#36), whose migrations 0025–0027 had been applied at 12:36Z.
- **Gates.** main ok; flag on; dry run ok; schema ok; challenge ok; configuration ok; broker secrets ok; census ok. The flag was on before each Worker and after the api.
- **Versions** (each `deployed`):

  | Worker | Previous | New |
  |---|---|---|
  | broker | `2c9bafb6` | `86301bfc-41ac-409f-a338-e431cb5a5350` |
  | orchestrator | `46903488` | `17cdb089-1f81-40f4-b37d-c33146451c86` |
  | connector | `e4423af1` | `f3fe1bf8-e59c-4d4b-b3ba-0324cc978f6f` |
  | api | `af583bdc` | `e60e8761-c457-4e60-9d8e-f2e4123d72eb` |

- **Health and smoke.**
  - Health ready after 1 poll (988 ms).
  - Smoke: health ready; spa 200 with CSP; routing navigate 200, plain 200, api 404 JSON; guard configured (start 403); **database path 401**; broker, orchestrator and connector hostnames 404 non-JSON.
  - **No failures.**
- **Census, before and after.** Only the api is on workers.dev. The api binds the broker as `ApiBroker`, and after the deploy the connector binds it as `ConnectorBroker` (M2's allow table). No Pages projects; `dispatchNamespaces` unavailable_10121; 1 member; no findings.
- **Latency, measured by Claude after the deploy.** `GET /workspaces` with a random session answered 401 in 2.25 s (Neon compute waking), then 0.85 s and 0.88 s. Before placement it took about 5.0 s and once answered 503. Placement in `aws:us-east-1` is therefore confirmed as the fix for `SMOKE_DATABASE_PATH`.
- **Cap and observed cost.** Within Workers Paid included usage (not separately observed).
- **Unknown outcomes.** None.
