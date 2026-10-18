import { createSelfLogoutControl } from "./self-logout-control.js";
import {
  assertSessionBrowserProof,
  readSchemaVersionBody,
  SESSION_COOKIE_CLEAR,
} from "./request-primitives.js";
import type { StandaloneWorkspaceSqlPool } from "./standalone-workspace-bootstrap.js";
import {
  createLoginAttempt,
  LoginInputError,
  loginHash,
  loginId,
  loginJson,
  loginRequestEnvelope,
  loginSecret,
  loginUuid,
  type LoginAttempt,
} from "./standalone-login-protocol.js";

export interface LogoutDeliveryPlan {
  readonly status: 200 | 400 | 403 | 404 | 405 | 503;
  readonly headers: readonly (readonly [string, string])[];
  readonly cookies: readonly string[];
  readonly bodyText: string;
}
export type LogoutDeliverySink = (plan: Readonly<LogoutDeliveryPlan>) => void;
export interface StandaloneLogoutDependencies {
  readonly configurationJson: string;
  readonly pool: StandaloneWorkspaceSqlPool;
  readonly now: () => number;
}
export interface StandaloneLogoutConfiguration {
  readonly origin: string;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly clientId: string;
  readonly profileId: string;
  readonly configurationDigest: string;
}
const encoder = new TextEncoder();
const fixedFailure = () => Error("STANDALONE_LOGOUT_HELD");
// P05.T01y: only plans produced after the SQL call was invoked carry the clear, so a
// request that never reached SQL (a cross-site one included) cannot clear the cookie.
function plan(
  status: LogoutDeliveryPlan["status"],
  outcome: "session_ended" | "logout_unavailable" | "logout_outcome_unknown",
  clear = false,
): Readonly<LogoutDeliveryPlan> {
  return Object.freeze({
    status,
    headers: Object.freeze([
      Object.freeze(["content-type", "application/json; charset=utf-8"] as const),
      Object.freeze(["cache-control", "no-store"] as const),
      Object.freeze(["x-content-type-options", "nosniff"] as const),
      Object.freeze(["referrer-policy", "no-referrer"] as const),
    ]),
    cookies: Object.freeze(clear ? [SESSION_COOKIE_CLEAR] : []),
    bodyText: JSON.stringify({ schemaVersion: 1, outcome }),
  });
}
const unavailable = (status: LogoutDeliveryPlan["status"] = 503, clear = false) =>
  plan(status, "logout_unavailable", clear);
const unknown = () => plan(503, "logout_outcome_unknown", true);
async function configuration(
  value: unknown,
  originalAttempt?: LoginAttempt,
): Promise<Readonly<StandaloneLogoutConfiguration>> {
  try {
    const c = loginJson(value, 8192, [
      "schemaVersion",
      "protocol",
      "origin",
      "providerId",
      "environmentId",
      "applicationId",
      "clientId",
      "profileId",
    ]);
    if (
      c.schemaVersion !== 1 ||
      c.protocol !== "morrow-self-logout-v1" ||
      c.providerId !== "workos" ||
      typeof c.origin !== "string" ||
      encoder.encode(c.origin).length > 512 ||
      !loginId(c.profileId) ||
      typeof c.environmentId !== "string" ||
      !/^environment_[A-Z0-9]{26}$/.test(c.environmentId) ||
      typeof c.applicationId !== "string" ||
      !/^app_[A-Z0-9]{26}$/.test(c.applicationId) ||
      typeof c.clientId !== "string" ||
      !/^client_[A-Z0-9]{26}$/.test(c.clientId)
    )
      throw fixedFailure();
    const u = new URL(c.origin);
    if (u.origin !== c.origin || u.protocol !== "https:" || u.username || u.password)
      throw fixedFailure();
    originalAttempt?.check();
    const pending = loginHash(
      JSON.stringify([
        "morrow.browser.self_logout.configuration",
        "1",
        c.protocol,
        c.origin,
        "workos",
        c.environmentId,
        c.applicationId,
        c.clientId,
        c.profileId,
      ]),
    );
    if (originalAttempt) void pending.catch(() => {});
    const configurationDigest = await (originalAttempt ? originalAttempt.wait(pending) : pending);
    originalAttempt?.check();
    return Object.freeze({
      origin: c.origin,
      environmentId: c.environmentId,
      applicationId: c.applicationId,
      clientId: c.clientId,
      profileId: c.profileId,
      configurationDigest,
    });
  } catch {
    throw Error("STANDALONE_LOGOUT_CONFIGURATION_INVALID");
  }
}
// The same configuration outside a request attempt (local compositions only).
export function parseStandaloneLogoutConfiguration(
  value: unknown,
): Promise<Readonly<StandaloneLogoutConfiguration>> {
  return configuration(value);
}
// Private source composition only; the caller retains ownership of this attempt.
export function parseStandaloneLogoutConfigurationWithAttempt(
  value: unknown,
  originalAttempt: LoginAttempt,
): Promise<Readonly<StandaloneLogoutConfiguration>> {
  return configuration(value, originalAttempt);
}
function capturedCookie(request: Request): string {
  const raw = request.headers.get("cookie");
  if (!raw || raw.length > 4096 || /[^\x20-\x7e]/.test(raw)) throw new LoginInputError(403);
  const pairs = raw.split(";");
  if (pairs.length > 32) throw new LoginInputError(403);
  const seen = new Set<string>();
  let secret: string | undefined;
  for (const pair of pairs) {
    const m = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/.exec(
      pair.trim(),
    );
    if (!m) throw new LoginInputError(403);
    const name = m[1]!,
      lower = name.toLowerCase();
    if (lower === "__host-morrow_session" || lower === "__host-morrow_login") {
      if (
        seen.has(lower) ||
        (name !== "__Host-morrow_session" && name !== "__Host-morrow_login") ||
        !loginSecret(m[2])
      )
        throw new LoginInputError(403);
      seen.add(lower);
      if (name === "__Host-morrow_session") secret = m[2];
    }
  }
  if (!secret) throw new LoginInputError(403);
  return secret;
}
type LogoutDispatchEntry =
  | Readonly<{ kind: "legacy"; now: () => number }>
  | Readonly<{ kind: "managed"; attempt: LoginAttempt }>;

async function dispatchStandaloneLogoutCore(
  request: Request,
  sink: LogoutDeliverySink,
  config: Readonly<StandaloneLogoutConfiguration>,
  pool: StandaloneWorkspaceSqlPool,
  entry: LogoutDispatchEntry,
): Promise<void> {
  let attempt: LoginAttempt | undefined,
    invoked = false,
    delivered = false;
  let signal: AbortSignal | undefined;
  const deliver = (output: Readonly<LogoutDeliveryPlan>, fresh = true) => {
    if (fresh) attempt?.check();
    if (delivered || typeof sink !== "function") throw fixedFailure();
    delivered = true;
    const result: unknown = sink(output);
    if (result !== undefined) {
      // Only native Promise internals are touched; no untrusted then getter.
      try {
        Promise.prototype.then.call(
          result,
          () => {},
          () => {},
        );
      } catch {}
      throw Error("STANDALONE_LOGOUT_TRANSPORT_UNKNOWN");
    }
  };
  try {
    if (!(request instanceof Request) || typeof sink !== "function") throw fixedFailure();
    signal = request.signal;
    attempt = entry.kind === "legacy" ? createLoginAttempt(entry.now, signal, 5000) : entry.attempt;
    attempt.check();
    const url = loginRequestEnvelope(request, config.origin);
    if (url.pathname !== "/auth/logout") {
      deliver(unavailable(404));
      return;
    }
    if (request.url !== config.origin + "/auth/logout") throw new LoginInputError(400);
    if (request.method !== "POST") {
      deliver(unavailable(405));
      return;
    }
    assertSessionBrowserProof(request, config.origin);
    // Snapshot once, hash canonical TEXT rather than decoded bytes, and retain
    // no separate raw proof across body/SQL awaits.
    if (entry.kind === "managed") attempt.check();
    const sessionDigest = await attempt.wait(loginHash(capturedCookie(request)));
    await readSchemaVersionBody(request, attempt);
    attempt.check();
    const commandId = crypto.randomUUID();
    if (!loginUuid(commandId)) throw fixedFailure();
    if (entry.kind === "managed") attempt.check();
    const requestDigest = await attempt.wait(
      loginHash(
        JSON.stringify([
          "morrow.browser.self_logout",
          "1",
          commandId,
          config.configurationDigest,
          "workos",
          config.environmentId,
          config.applicationId,
          config.clientId,
          config.profileId,
          sessionDigest,
        ]),
      ),
    );
    const service = createSelfLogoutControl({ pool, now: attempt.check });
    const answer = await attempt.wait(
      service.end(
        JSON.stringify({
          schemaVersion: 1,
          commandId,
          requestDigest,
          configurationDigest: config.configurationDigest,
          environmentId: config.environmentId,
          applicationId: config.applicationId,
          clientId: config.clientId,
          profileId: config.profileId,
          sessionDigest,
        }),
        attempt.control(),
        () => {
          invoked = true;
        },
      ),
    );
    attempt.check();
    if (answer.outcome === "ended") deliver(plan(200, "session_ended", invoked));
    else if (answer.outcome === "denied") deliver(unavailable(403, invoked));
    else if (answer.outcome === "unknown") deliver(unknown());
    else deliver(unavailable());
  } catch (error) {
    if (delivered) throw Error("STANDALONE_LOGOUT_TRANSPORT_UNKNOWN");
    // Failure acknowledgement grants no authority and changes no cookies.
    // An aborted transport receives no late replacement delivery.
    if (!signal?.aborted)
      deliver(
        invoked ? unknown() : unavailable(error instanceof LoginInputError ? error.status : 503),
        false,
      );
  } finally {
    if (entry.kind === "legacy") attempt?.end();
  }
}

// Source-owned same-attempt seam; no new timer, controller or end ownership.
export function dispatchStandaloneLogoutWithAttempt(
  request: Request,
  sink: LogoutDeliverySink,
  originalAttempt: LoginAttempt,
  config: Readonly<StandaloneLogoutConfiguration>,
  pool: StandaloneWorkspaceSqlPool,
): Promise<void> {
  return dispatchStandaloneLogoutCore(request, sink, config, pool, {
    kind: "managed",
    attempt: originalAttempt,
  });
}

// Source-owned local composition. No provider, administrative target or caller
// authority is accepted. Retirement is derived only from this Request's cookie.
export async function createStandaloneLogout(dependencies: StandaloneLogoutDependencies) {
  let config: Awaited<ReturnType<typeof configuration>>;
  let pool: StandaloneWorkspaceSqlPool, now: () => number;
  try {
    config = await configuration(dependencies.configurationJson);
    ({ pool, now } = dependencies);
    if (!pool || typeof pool.connect !== "function" || typeof now !== "function")
      throw fixedFailure();
  } catch {
    throw Error("STANDALONE_LOGOUT_CONFIGURATION_INVALID");
  }
  const dispatch = (request: Request, sink: LogoutDeliverySink): Promise<void> =>
    dispatchStandaloneLogoutCore(request, sink, config, pool, { kind: "legacy", now });
  const fetch = async (request: Request): Promise<Response> => {
    let response: Response | undefined;
    await dispatch(request, (output) => {
      const headers = new Headers(
        output.headers.map(([name, value]) => [name, value] as [string, string]),
      );
      for (const cookie of output.cookies) headers.append("Set-Cookie", cookie);
      response = new Response(output.bodyText, { status: output.status, headers });
    });
    if (!response) throw fixedFailure();
    return response;
  };
  return Object.freeze({ fetch, dispatch });
}
