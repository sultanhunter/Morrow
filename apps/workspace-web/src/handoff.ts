// The install continuation the connector's redirect carries (M2 PR-2; P09.T02a;
// mvp-architecture §2 step 5): exactly `/w/:workspaceId/connections#handoff=<token>`, with no
// query. It is read once per page load, before the router exists, and the fragment is
// replaced at once, so the token never stays in the address bar or the history entry. It
// lives in memory only: never in storage, a log, a Referer or the intended route. A sign-in
// round trip loses it; the merchant reopens Morrow from the Shopify admin, which issues a
// fresh one. Every other fragment or query still renders NotFound (router.ts).
import { matchWorkspacePath, workspaceRoutes } from "@morrow/contracts/routes";

/** The 32-byte base64url secret shape the api guard accepts (no padding, canonical tail). */
export const handoffTokenPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const fragment = /^#handoff=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;

export interface Handoff {
  readonly workspaceId: string;
  readonly token: string;
  /** One command key for preview, apply and status, minted at capture (§4.7). */
  readonly key: string;
}
export interface HandoffWindow {
  readonly location: { readonly pathname: string; readonly search: string; readonly hash: string };
  readonly history: { replaceState(data: unknown, unused: string, url: string): void };
}

/**
 * Takes the continuation out of the address, or returns null and leaves the address alone.
 * `newKey` mints the command key (a lowercase UUID v4).
 */
export function captureHandoff(win: HandoffWindow, newKey: () => string): Handoff | null {
  const { pathname, search, hash } = win.location;
  if (search !== "" || !hash.startsWith("#handoff=")) return null;
  const match = matchWorkspacePath(workspaceRoutes, pathname, "standalone");
  const token = fragment.exec(hash)?.[1];
  if (match?.id !== "connections" || token === undefined) return null;
  const workspaceId = match.params.workspaceId;
  if (typeof workspaceId !== "string") return null;
  // The bare path replaces the entry before anything renders or is requested.
  win.history.replaceState(null, "", pathname);
  return Object.freeze({ workspaceId, token, key: newKey() });
}
