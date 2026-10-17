// Paths the api Worker serves ahead of Static Assets (`assets.run_worker_first`).
// `/api` is held for P05.T01x. `npm run edge:check` requires every wrangler
// environment to use exactly this list and no SPA route to fall under it.
export const reservedWorkerPaths = Object.freeze([
  "/auth",
  "/auth/*",
  "/workspace",
  "/workspace/*",
  "/api",
  "/api/*",
  "/healthz",
] as const);
