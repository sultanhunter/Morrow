// Paths the api Worker serves ahead of Static Assets (`assets.run_worker_first`).
// `/workspaces` and `/organizations` are the exact P05.T01x account routes; `/api`
// stays held. `npm run edge:check` requires every wrangler environment to use
// exactly this list and no SPA route to fall under it.
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
