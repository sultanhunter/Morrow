// One History-API router on the single matcher (P14.T01a §4.5). Paths come from
// `buildWorkspacePath`; queries and fragments carry no state, so a path with either
// renders NotFound. The one exception, the install continuation of
// `/w/:ws/connections#handoff=` (M2 PR-2), is taken out of the address by handoff.ts
// before a router exists, so the router never sees it. Back and forward restore the logical path, and pass the leave guard:
// a blocked `popstate` re-pushes the current path and asks first.
import { matchWorkspacePath, workspaceRoutes, type RouteMatch } from "@morrow/contracts/routes";

export interface RouteState {
  readonly path: string;
  readonly match: RouteMatch | null;
}
export interface RouterWindow {
  readonly location: { readonly pathname: string; readonly search: string; readonly hash: string };
  readonly history: {
    pushState(data: unknown, unused: string, url: string): void;
    replaceState(data: unknown, unused: string, url: string): void;
  };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}
export interface LeaveRequest {
  readonly target: string;
  readonly replace: boolean;
}
export interface Router {
  state(): RouteState;
  subscribe(listener: () => void): () => void;
  navigate(
    path: string,
    options?: { readonly replace?: boolean; readonly force?: boolean },
  ): boolean;
  /** Aborts when the person navigates away; reads use it. */
  signal(): AbortSignal;
  dispose(): void;
}

let activeRouter: Router | null = null;
/** The current navigation's signal; reads abort when the person navigates away. */
export const navigationSignal = (): AbortSignal | undefined => activeRouter?.signal();

export function readLocation(location: RouterWindow["location"]): RouteState {
  const path = location.pathname + location.search + location.hash;
  if (location.search !== "" || location.hash !== "") return { path, match: null };
  return { path, match: matchWorkspacePath(workspaceRoutes, location.pathname, "standalone") };
}

export function createRouter(
  win: RouterWindow,
  guard: { blocking(): boolean },
  onBlocked: (request: LeaveRequest) => void,
): Router {
  let current = readLocation(win.location);
  let controller = new AbortController();
  const listeners = new Set<() => void>();
  const commit = (path: string, mode: "push" | "replace" | "pop") => {
    if (mode === "push") win.history.pushState(null, "", path);
    else if (mode === "replace") win.history.replaceState(null, "", path);
    controller.abort();
    controller = new AbortController();
    current = readLocation(win.location);
    for (const listener of [...listeners]) listener();
  };
  const onPop = () => {
    const target = readLocation(win.location).path;
    if (target === current.path) return;
    if (guard.blocking()) {
      win.history.pushState(null, "", current.path);
      onBlocked({ target, replace: false });
      return;
    }
    commit(target, "pop");
  };
  win.addEventListener("popstate", onPop);
  const router: Router = {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    navigate(path, { replace = false, force = false } = {}) {
      if (!path.startsWith("/") || path.startsWith("//")) return false;
      if (path === current.path && !replace) return true;
      if (!force && guard.blocking()) {
        onBlocked({ target: path, replace });
        return false;
      }
      commit(path, replace ? "replace" : "push");
      return true;
    },
    signal: () => controller.signal,
    dispose() {
      win.removeEventListener("popstate", onPop);
      listeners.clear();
      if (activeRouter === router) activeRouter = null;
    },
  };
  activeRouter = router;
  return router;
}
