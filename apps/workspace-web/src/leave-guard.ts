// The minimal leave guard (P14.T01a §4.9; workspace-routes.md "guard unsaved input").
// While a form is dirty or a command is pending or uncertain, in-app navigation asks
// first, and `beforeunload` is registered; otherwise it is not. A 401 or a sign-out
// bypasses the guard.
export interface GuardWindow {
  addEventListener(type: "beforeunload", listener: (event: BeforeUnloadEvent) => void): void;
  removeEventListener(type: "beforeunload", listener: (event: BeforeUnloadEvent) => void): void;
}
export interface LeaveGuard {
  setDirty(token: object, dirty: boolean): void;
  hasDirty(): boolean;
  blocking(): boolean;
  /** Drops every dirty token (401, sign-out); pending commands are the caller's to clear. */
  bypass(): void;
  /** Re-reads the pending state, for example after a command settles. */
  sync(): void;
  beforeUnloadRegistered(): boolean;
}

export function createLeaveGuard(
  win: GuardWindow,
  pendingBlocking: () => boolean = () => false,
): LeaveGuard {
  const dirty = new Set<object>();
  let registered = false;
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
  };
  const blocking = () => dirty.size > 0 || pendingBlocking();
  const sync = () => {
    const needed = blocking();
    if (needed && !registered) {
      win.addEventListener("beforeunload", onBeforeUnload);
      registered = true;
    } else if (!needed && registered) {
      win.removeEventListener("beforeunload", onBeforeUnload);
      registered = false;
    }
  };
  return {
    setDirty(token, on) {
      if (on) dirty.add(token);
      else dirty.delete(token);
      sync();
    },
    hasDirty: () => dirty.size > 0,
    blocking,
    bypass() {
      dirty.clear();
      sync();
    },
    sync,
    beforeUnloadRegistered: () => registered,
  };
}
