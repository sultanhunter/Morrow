// The intended route (P14.T01a §4.5): one validated `/w/…` path in sessionStorage,
// written when a workspace request needs sign-in, read once at `/` after the callback's
// 303, re-validated and deleted before use. Full URLs, `//x`, traversal, encoded
// slashes and queries are refused, so it can never become an open redirect.
import { matchWorkspacePath, workspaceRoutes } from "@morrow/contracts/routes";

export const intendedStorageKey = "morrow.intended.v1";
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
function tabStorage(): StorageLike | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function isIntendedPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 2048 || !path.startsWith("/w/")) return false;
  // The matcher decodes each segment once and validates it, so `%2F` and `%2e%2e` fail.
  if (
    /[?#\\]/.test(path) ||
    path.includes("//") ||
    path.split("/").some((s) => s === "." || s === "..")
  )
    return false;
  return matchWorkspacePath(workspaceRoutes, path, "standalone") !== null;
}

/** Stores `path` when it is a valid workspace path; otherwise clears any stored one. */
export function storeIntended(path: string, storage: StorageLike | null = tabStorage()) {
  if (!storage) return;
  try {
    if (isIntendedPath(path)) storage.setItem(intendedStorageKey, path);
    else storage.removeItem(intendedStorageKey);
  } catch {}
}

/** Reads the stored path once, deletes it, and returns it only if it still validates. */
export function takeIntended(storage: StorageLike | null = tabStorage()): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(intendedStorageKey);
    storage.removeItem(intendedStorageKey);
    return isIntendedPath(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearIntended(storage: StorageLike | null = tabStorage()) {
  try {
    storage?.removeItem(intendedStorageKey);
  } catch {}
}
