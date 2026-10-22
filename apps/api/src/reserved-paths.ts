// Paths the api Worker serves ahead of Static Assets (`assets.run_worker_first`).
// `/workspaces` and `/organizations` are the exact P05.T01x account routes. Under `/api`
// the api Worker now serves exactly POST /api/billing/stripe/webhook (M5 PR-1, the
// dispatch table in worker.ts); every other `/api` path stays held by the account
// handler. `npm run edge:check` requires every wrangler environment to use exactly this
// list and no SPA route to fall under it.
export const reservedWorkerPaths = Object.freeze([
  "/auth",
  "/auth/*",
  "/workspace",
  "/workspace/*",
  "/workspaces",
  "/organizations",
  "/api",
  "/api/*",
  "/healthz",
] as const);
