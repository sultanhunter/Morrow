// Identity reply decoders (P14.T01a §4.8): the `{schemaVersion:1, outcome}` and `{code}`
// bodies of the P05 login, logout, bootstrap and account routes. Hand-written: no eval,
// no schema compilation, unknown properties ignored. Each (status, outcome) pair maps to
// fixed copy; no server text or reference is shown.
import type { Outcome, WorkspaceView } from "@morrow/workspace-ui";
import { isId, type Reply } from "./client";

export const workosAuthorizeEndpoint = "https://api.workos.com/user_management/authorize";
/** The only sign-in target: the pinned WorkOS origin and path, no credentials or fragment. */
export function isWorkosAuthorizeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || value.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    url.origin + url.pathname === workosAuthorizeEndpoint
  );
}

export type Mode = "read" | "command";
export const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const identityBody = (body: unknown, outcomes: readonly string[]) =>
  record(body) &&
  body.schemaVersion === 1 &&
  typeof body.outcome === "string" &&
  outcomes.includes(body.outcome);
const unavailable = (offline = false) => ({ kind: "unavailable", offline }) as const;
const uncertain = { kind: "uncertain" } as const;
const notDecoded = (mode: Mode) => (mode === "read" ? unavailable() : uncertain);

/** Retry-After as an integer from 1 to 86400 seconds, 600 otherwise. */
export function retryAfter(headers: Headers): number {
  const value = headers.get("retry-after");
  if (value === null || !/^[0-9]{1,5}$/.test(value)) return 600;
  const seconds = Number(value);
  return seconds >= 1 && seconds <= 86400 ? seconds : 600;
}

/** Transport failures: nothing sent is unavailable; anything after the send is uncertain. */
export function failureOutcome(reply: Exclude<Reply, { kind: "response" }>, mode: Mode) {
  if (reply.kind === "not_sent") return unavailable(reply.offline);
  if (reply.kind === "aborted") return unavailable();
  return notDecoded(mode);
}

export function decodeLoginStart(reply: Reply): Outcome<{ readonly navigateTo: string }> {
  if (
    reply.kind === "response" &&
    reply.status === 200 &&
    record(reply.body) &&
    reply.body.schemaVersion === 1 &&
    isWorkosAuthorizeUrl(reply.body.authorizationUrl)
  )
    return { kind: "ok", value: { navigateTo: reply.body.authorizationUrl }, replayed: false };
  // Any other reply, including 503 login_unavailable, is "Sign-in couldn't start".
  return unavailable(reply.kind === "not_sent" && reply.offline);
}

export function decodeLogout(reply: Reply): Outcome<"ended"> {
  if (reply.kind !== "response") return failureOutcome(reply, "command");
  const { status, body } = reply;
  if (status === 200 && identityBody(body, ["session_ended"]))
    return { kind: "ok", value: "ended", replayed: false };
  if (status === 403 && identityBody(body, ["logout_unavailable"]))
    return { kind: "denied", message: "", reference: null };
  if (status === 503 && identityBody(body, ["logout_unavailable"])) return unavailable();
  if (status === 503 && identityBody(body, ["logout_outcome_unknown"])) return uncertain;
  // A request the guard refused (400, 405) never ran; any other reply can't be confirmed.
  if (status === 400 || status === 405) return unavailable();
  return uncertain;
}

export function decodeBootstrap(reply: Reply, workspaceId: string): Outcome<WorkspaceView> {
  if (reply.kind !== "response") return failureOutcome(reply, "read");
  const { status, body } = reply;
  if (status === 401) return { kind: "unauthenticated" };
  if (
    status === 200 &&
    record(body) &&
    body.schemaVersion === 1 &&
    record(body.workspace) &&
    isId(body.workspace.id) &&
    body.workspace.id === workspaceId &&
    typeof body.workspace.displayName === "string" &&
    body.workspace.displayName.length >= 1 &&
    body.workspace.displayName.length <= 200 &&
    typeof body.policyRevision === "number" &&
    Number.isSafeInteger(body.policyRevision) &&
    body.policyRevision >= 0
  )
    return {
      kind: "ok",
      value: {
        id: body.workspace.id,
        displayName: body.workspace.displayName,
        policyRevision: body.policyRevision,
      },
      replayed: false,
    };
  return unavailable();
}

/**
 * The account routes (P05.T01x §9): GET /workspaces and POST /organizations. A terminal
 * outcome needs a decoded identity body; anything else stays unavailable (reads) or
 * uncertain (commands). `pending.ts` keeps a once-uncertain command uncertain.
 */
export function identityOutcome<T>(
  reply: Reply,
  mode: Mode,
  decode: (body: unknown, status: number) => T | null,
): Outcome<T> {
  if (reply.kind !== "response") return failureOutcome(reply, mode);
  const { status, body } = reply;
  if (status >= 200 && status < 300) {
    const value = decode(body, status);
    if (value === null) return notDecoded(mode);
    return { kind: "ok", value, replayed: record(body) && body.outcome === "replayed" };
  }
  if (status === 401) return { kind: "unauthenticated" };
  if (status === 400 && identityBody(body, ["invalid_name"]))
    return { kind: "invalid", field: "name" };
  if (status === 403 && identityBody(body, ["signup_unavailable"]))
    return { kind: "denied", message: "", reference: null };
  if (status === 409 && identityBody(body, ["already_onboarded", "idempotency_conflict"]))
    return {
      kind: "conflict",
      recheck: record(body) && body.outcome === "already_onboarded",
      message: "",
    };
  if (status === 429 && identityBody(body, ["rate_limited"]))
    return { kind: "rate_limited", retryAfterSeconds: retryAfter(reply.headers) };
  if (status === 503 && record(body) && body.code === "unavailable") return unavailable();
  if (status === 503 && identityBody(body, ["outcome_unknown"])) return notDecoded(mode);
  return notDecoded(mode);
}
