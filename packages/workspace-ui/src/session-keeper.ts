import { validateSessionRotationResult } from "@morrow/contracts/validators/SessionRotationResult";

// The client session keeper (P05.T01y §7, ADR-0004). Framework-free. Workspace and work
// routes record no session activity, so the keeper rotates the session while the person
// is active: at most once per 5 monotonic minutes after the last 200 rotate response, and
// only after user input. request(), openStream(), timers and polling never count as
// activity, so an unattended screen idles out 30-35 minutes after the last input.
//
// Every 401 from request() is answered with one rotate under the exclusive lock (shared by
// concurrent 401s). That rotate presents the browser's cookie: if a thief rotated first,
// the server sees a retired generation and revokes the family (reuse), and the rotate 401
// signs this tab out. Only a rotate 401 signs out. A 200 rotate is reused for a 401 only
// when it settled after the failing request was sent: only then can it explain the 401.
//
// A separate entry (`@morrow/workspace-ui/session-keeper`), not re-exported by the package
// index until P14.T01a wires it into the UI. It imports the generated per-definition
// validator for the effective `SessionRotationResult`, never the validator table, which
// `verify:workspace-web` denies in browser bundles and checks for this entry.

export interface SessionKeeperOptions {
  readonly fetch: typeof fetch;
  /** navigator.locks, or null: then single flight within the tab (a documented residual). */
  readonly locks: LockManager | null;
  /** Monotonic milliseconds (performance.now in a browser). */
  readonly now: () => number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onSignedOut(): void;
  onExpiry?(expiry: { idleRemainingMs: number; absoluteRemainingMs: number }): void;
}
export interface SessionKeeper {
  /** Call only from user-input handlers: pointer down, key down, focus, visible again. */
  noteActivity(): void;
  /** A same-origin API request, held behind an in-flight rotation, with 401 recovery. */
  request(input: string, init?: RequestInit): Promise<Response>;
  /** A long poll or event stream: never locked, never activity, never retried. */
  openStream(input: string, init?: RequestInit): Promise<Response>;
  dispose(): void;
}
type RotateResult = "rotated" | "current" | "signed_out" | "unavailable";

export const SESSION_KEEPER_LOCK = "morrow.session";
export const SESSION_ROTATE_INTERVAL_MS = 5 * 60 * 1000;
export const SESSION_ROTATE_RETRY_MS = 60 * 1000;
const LOCK_TIMEOUT_MS = 10000;
// How long the keeper waits for a rotate reply: the server's 5 s attempt plus network slack.
// The fetch itself is never aborted, so a late Set-Cookie still reaches the jar.
export const SESSION_ROTATE_WAIT_MS = 15000;
const ROTATE_PATH = "/auth/rotate";

function replayable(body: RequestInit["body"]): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) ||
    (typeof FormData !== "undefined" && body instanceof FormData)
  );
}

export function createSessionKeeper(options: Readonly<SessionKeeperOptions>): SessionKeeper {
  const { fetch: send, locks, now, setTimer, clearTimer, onSignedOut, onExpiry } = options;
  // Anchor: the monotonic time of the last 200 rotate response, or creation.
  let anchor = now();
  let lastActivity: number | null = null;
  let initial = true;
  // Each 200 rotate response gets the next sequence number; a request records the number
  // current when it was sent.
  let successes = 0;
  let lastSuccess: { at: number; seq: number; outcome: "rotated" | "current" } | null = null;
  // After a non-401 failure: no retry before the next activity and at least 60 s.
  let failedAt: number | null = null;
  let timer: unknown = null;
  let rotation: Promise<RotateResult> | null = null;
  let signedOut = false,
    disposed = false;

  const signOut = () => {
    if (signedOut || disposed) return;
    signedOut = true;
    cancelTimer();
    onSignedOut();
  };
  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule(at: number) {
    if (disposed || signedOut || timer !== null) return;
    timer = setTimer(
      () => {
        timer = null;
        evaluate();
      },
      Math.max(0, at - now()),
    );
  }
  // The rotate request itself: keepalive, never aborted, so the server's 5 s attempt
  // always ends first. A 200 must be a valid SessionRotationResult. `live` turns false once
  // the keeper stopped waiting (bounded below), so a late reply reports nothing.
  async function rotateOnce(live: () => boolean): Promise<RotateResult> {
    let response: Response;
    try {
      response = await send(ROTATE_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Morrow-Request": "1" },
        body: '{"schemaVersion":1}',
        keepalive: true,
        cache: "no-store",
      });
    } catch {
      return "unavailable";
    }
    if (response.status === 401) return "signed_out";
    if (response.status !== 200) return "unavailable";
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return "unavailable";
    }
    if (!validateSessionRotationResult(body)) return "unavailable";
    const result = body as {
      outcome: "rotated" | "current";
      idleRemainingMs: number;
      absoluteRemainingMs: number;
    };
    if (!live()) return "unavailable";
    try {
      onExpiry?.({
        idleRemainingMs: result.idleRemainingMs,
        absoluteRemainingMs: result.absoluteRemainingMs,
      });
    } catch {
      // A UI callback failure never changes the session outcome.
    }
    return result.outcome;
  }
  // The keeper waits at most SESSION_ROTATE_WAIT_MS for the reply; a stalled response
  // (dead connection, a proxy holding it) settles as unavailable, which releases the
  // exclusive lock and the single flight, so 401 recovery returns instead of hanging.
  function rotateBounded(): Promise<RotateResult> {
    return new Promise((resolve) => {
      let waiting = true;
      const handle = setTimer(() => {
        waiting = false;
        resolve("unavailable");
      }, SESSION_ROTATE_WAIT_MS);
      void rotateOnce(() => waiting)
        .catch((): RotateResult => "unavailable")
        .then((result) => {
          if (!waiting) return;
          waiting = false;
          clearTimer(handle);
          resolve(result);
        });
    });
  }
  function settle(result: RotateResult): RotateResult {
    const at = now();
    if (result === "rotated" || result === "current") {
      anchor = at;
      successes += 1;
      lastSuccess = { at, seq: successes, outcome: result };
      failedAt = null;
    } else if (result === "signed_out") signOut();
    else failedAt = at;
    return result;
  }
  // One rotation at a time per browser (exclusive Web Lock) and per tab (single flight).
  function rotate(): Promise<RotateResult> {
    if (rotation) return rotation;
    initial = false;
    const run = async (): Promise<RotateResult> => {
      if (disposed || signedOut) return "unavailable";
      if (!locks) return settle(await rotateBounded());
      try {
        return (await locks.request(
          SESSION_KEEPER_LOCK,
          { mode: "exclusive", signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) },
          async () => (disposed || signedOut ? "unavailable" : settle(await rotateBounded())),
        )) as RotateResult;
      } catch {
        // Lock timeout: skip until the next activity (no failure backoff).
        return "unavailable";
      }
    };
    rotation = run().finally(() => {
      rotation = null;
    });
    return rotation;
  }
  // Rotate only after user input since the anchor, at most once per 5 minutes from it,
  // and never within 60 s of a failure or before new input after one.
  function evaluate() {
    if (disposed || signedOut || rotation || lastActivity === null) return;
    const at = now();
    if (failedAt !== null) {
      if (lastActivity <= failedAt) return;
      if (at < failedAt + SESSION_ROTATE_RETRY_MS) schedule(failedAt + SESSION_ROTATE_RETRY_MS);
      // A failed attempt was already due: retry once input and 60 s have both passed.
      else void rotate();
      return;
    }
    if (initial) {
      void rotate();
      return;
    }
    if (lastActivity <= anchor) return;
    if (at >= anchor + SESSION_ROTATE_INTERVAL_MS) void rotate();
    else schedule(anchor + SESSION_ROTATE_INTERVAL_MS);
  }
  // A 401 recovery reuses a 200 rotate from the last 60 s only if it settled after the
  // failing request was sent (`sentAt` is the success sequence at send); otherwise one
  // shared rotate, which presents the cookie so that a retired generation is caught as reuse.
  async function recover(sentAt: number): Promise<RotateResult> {
    if (signedOut) return "signed_out";
    if (lastSuccess && lastSuccess.seq > sentAt && now() - lastSuccess.at < SESSION_ROTATE_RETRY_MS)
      return lastSuccess.outcome;
    return rotate();
  }
  async function locked(
    input: string,
    init: RequestInit | undefined,
  ): Promise<{ response: Response; sentAt: number }> {
    let sentAt = successes;
    const dispatch = () => {
      sentAt = successes;
      return send(input, init);
    };
    if (!locks) {
      // Single flight within the tab: wait for an in-flight rotation first.
      if (rotation) await rotation.catch(() => undefined);
      return { response: await dispatch(), sentAt };
    }
    let started = false;
    try {
      // Held from send until the response headers arrive (fetch resolves at headers).
      const response = (await locks.request(
        SESSION_KEEPER_LOCK,
        { mode: "shared", signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) },
        () => {
          started = true;
          return dispatch();
        },
      )) as Response;
      return { response, sentAt };
    } catch (error) {
      if (started) throw error;
      // The lock was not granted in time: send unlocked.
      return { response: await dispatch(), sentAt };
    }
  }
  return Object.freeze({
    noteActivity() {
      if (disposed || signedOut) return;
      lastActivity = now();
      evaluate();
    },
    async request(input: string, init?: RequestInit): Promise<Response> {
      const { response, sentAt } = await locked(input, init);
      if (response.status !== 401 || disposed) return response;
      const outcome = await recover(sentAt);
      if ((outcome === "rotated" || outcome === "current") && replayable(init?.body)) {
        // One retry. A second 401 is returned without signing out: the session is valid,
        // so the workspace itself is unavailable to this person.
        return (await locked(input, init)).response;
      }
      return response;
    },
    async openStream(input: string, init?: RequestInit): Promise<Response> {
      const sentAt = successes;
      const response = await send(input, init);
      if (response.status === 401 && !disposed) await recover(sentAt);
      return response;
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  });
}

/**
 * Binds the user-input activity sources to a keeper: pointer down, key down and focus on
 * the window, and the document becoming visible. Returns the unbind function.
 */
export function bindSessionActivity(
  keeper: Pick<SessionKeeper, "noteActivity">,
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  document: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">,
): () => void {
  const note = () => keeper.noteActivity();
  const visible = () => {
    if (document.visibilityState === "visible") keeper.noteActivity();
  };
  const events = ["pointerdown", "keydown", "focus"] as const;
  for (const name of events) target.addEventListener(name, note, { capture: true, passive: true });
  document.addEventListener("visibilitychange", visible);
  return () => {
    for (const name of events) target.removeEventListener(name, note, { capture: true });
    document.removeEventListener("visibilitychange", visible);
  };
}
