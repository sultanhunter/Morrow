import { CROSS_CLOCK_ALLOWANCE_MS } from "./clock-allowance.js";
import { createSelfRotationControl } from "./self-session-rotation-control.js";
import type { StandaloneWorkspaceSqlPool } from "./standalone-workspace-bootstrap.js";
import {
  parseStandaloneLogoutConfiguration,
  type StandaloneLogoutConfiguration,
  type StandaloneLogoutDependencies,
} from "./standalone-logout.js";
import {
  assertSessionBrowserProof,
  readSchemaVersionBody,
  sessionCookie,
  sessionCookieSecret,
  sessionSecretDigest,
} from "./request-primitives.js";
import {
  createLoginAttempt,
  LoginInputError,
  loginBase64,
  loginHash,
  loginRequestEnvelope,
  loginUuid,
  type LoginAttempt,
} from "./standalone-login-protocol.js";

// POST /auth/rotate (P05.T01y §4, ADR-0004): activity-driven generation rotation on the
// logout configuration, executor and pool. The new secret is a fresh 32-byte CSPRNG value;
// only its digest leaves the Worker, and it is delivered once, only on a committed rotated
// answer inside this attempt. Denials, reuse and a cookie under one second are the
// workspace guard's byte-identical 401; an outcome after the statement was sent and then
// lost is 503 rotation_outcome_unknown, never retried and never delivered late.
export interface RotationDeliveryPlan {
  readonly status: 200 | 400 | 401 | 403 | 404 | 405 | 503;
  readonly headers: readonly (readonly [string, string])[];
  readonly cookies: readonly string[];
  readonly bodyText: string;
}
export type RotationDeliverySink = (plan: Readonly<RotationDeliveryPlan>) => void;
// The SessionRotationResult bound: remaining times are integers 0..43,200,000 ms.
export const SESSION_ROTATION_MAXIMUM_REMAINING_MS = 43200000;
const fixedFailure = () => Error("STANDALONE_ROTATION_HELD");
const headers = Object.freeze([
  Object.freeze(["content-type", "application/json; charset=utf-8"] as const),
  Object.freeze(["cache-control", "no-store"] as const),
  Object.freeze(["x-content-type-options", "nosniff"] as const),
  Object.freeze(["referrer-policy", "no-referrer"] as const),
]);
function plan(
  status: RotationDeliveryPlan["status"],
  body: unknown,
  cookie?: string,
): Readonly<RotationDeliveryPlan> {
  return Object.freeze({
    status,
    headers,
    cookies: Object.freeze(cookie === undefined ? [] : [cookie]),
    bodyText: JSON.stringify(body),
  });
}
export const rotationAuthenticationRequiredBody = '{"code":"authentication_required"}';
const denied = () => plan(401, { code: "authentication_required" });
const unavailable = (status: RotationDeliveryPlan["status"] = 503) =>
  plan(status, { schemaVersion: 1, outcome: "rotation_unavailable" });
const unknown = () => plan(503, { schemaVersion: 1, outcome: "rotation_outcome_unknown" });

export function dispatchStandaloneRotationWithAttempt(
  request: Request,
  sink: RotationDeliverySink,
  attempt: LoginAttempt,
  config: Readonly<StandaloneLogoutConfiguration>,
  pool: StandaloneWorkspaceSqlPool,
): Promise<void> {
  return dispatch(request, sink, attempt, config, pool);
}

async function dispatch(
  request: Request,
  sink: RotationDeliverySink,
  attempt: LoginAttempt,
  config: Readonly<StandaloneLogoutConfiguration>,
  pool: StandaloneWorkspaceSqlPool,
): Promise<void> {
  let invoked = false,
    delivered = false,
    signal: AbortSignal | undefined;
  const deliver = (output: Readonly<RotationDeliveryPlan>, fresh = true) => {
    if (fresh) attempt.check();
    if (delivered || typeof sink !== "function") throw fixedFailure();
    delivered = true;
    const result: unknown = sink(output);
    if (result !== undefined) {
      try {
        Promise.prototype.then.call(
          result,
          () => {},
          () => {},
        );
      } catch {}
      throw Error("STANDALONE_ROTATION_TRANSPORT_UNKNOWN");
    }
  };
  try {
    if (!(request instanceof Request) || typeof sink !== "function") throw fixedFailure();
    signal = request.signal;
    attempt.check();
    const url = loginRequestEnvelope(request, config.origin);
    if (url.pathname !== "/auth/rotate") {
      deliver(unavailable(404));
      return;
    }
    if (request.url !== config.origin + "/auth/rotate") throw new LoginInputError(400);
    if (request.method !== "POST") {
      deliver(unavailable(405));
      return;
    }
    assertSessionBrowserProof(request, config.origin);
    await readSchemaVersionBody(request, attempt);
    attempt.check();
    // The workspace guard's cookie rules: zero, two or a malformed session cookie is the
    // same 401 as an unknown one, before any SQL.
    const presented = sessionCookieSecret(request.headers.get("cookie"));
    if (presented === null) {
      deliver(denied());
      return;
    }
    const presentedDigest = await attempt.wait(sessionSecretDigest(presented));
    const fresh = new Uint8Array(32);
    crypto.getRandomValues(fresh);
    const secret = loginBase64(fresh);
    fresh.fill(0);
    const newDigest = await attempt.wait(sessionSecretDigest(secret));
    const commandId = crypto.randomUUID(),
      newGenerationId = crypto.randomUUID();
    if (!loginUuid(commandId) || !loginUuid(newGenerationId) || commandId === newGenerationId)
      throw fixedFailure();
    attempt.check();
    const requestDigest = await attempt.wait(
      loginHash(
        JSON.stringify([
          "morrow.browser.self_rotate",
          "1",
          commandId,
          config.configurationDigest,
          "workos",
          config.environmentId,
          config.applicationId,
          config.clientId,
          config.profileId,
          presentedDigest,
          newDigest,
          newGenerationId,
        ]),
      ),
    );
    const service = createSelfRotationControl({ pool, now: attempt.check });
    const answer = await attempt.wait(
      service.rotate(
        JSON.stringify({
          schemaVersion: 1,
          commandId,
          requestDigest,
          configurationDigest: config.configurationDigest,
          environmentId: config.environmentId,
          applicationId: config.applicationId,
          clientId: config.clientId,
          profileId: config.profileId,
          presentedDigest,
          newDigest,
          newGenerationId,
        }),
        attempt.control(),
        () => {
          invoked = true;
        },
      ),
    );
    const at = attempt.check();
    if (answer.outcome === "rotated" || answer.outcome === "current") {
      // Remaining times relative to the attempt clock, so the client needs no wall clock.
      // The expiries are the database's clock and `at` the Worker's: a family rotated within
      // moments of its admission has an absolute expiry up to the database's lead past
      // at + 12 hours. Up to CROSS_CLOCK_ALLOWANCE_MS past the bound reads as the bound
      // (clock-allowance.ts); beyond it the answer is not trusted. Reporting less time than
      // the database granted never lengthens a lifetime. The rotation-control decoder already
      // refuses idle > absolute, so the absolute comparison dominates; the idle one is defence
      // in depth with no reachable case of its own.
      const idleRemainingMs = Math.max(0, answer.idleExpiresAtMs - at),
        absoluteRemainingMs = Math.max(0, answer.absoluteExpiresAtMs - at);
      if (
        idleRemainingMs > SESSION_ROTATION_MAXIMUM_REMAINING_MS + CROSS_CLOCK_ALLOWANCE_MS ||
        absoluteRemainingMs > SESSION_ROTATION_MAXIMUM_REMAINING_MS + CROSS_CLOCK_ALLOWANCE_MS
      ) {
        deliver(unknown());
        return;
      }
      const body = {
        schemaVersion: 1,
        outcome: answer.outcome,
        idleRemainingMs: Math.min(idleRemainingMs, SESSION_ROTATION_MAXIMUM_REMAINING_MS),
        absoluteRemainingMs: Math.min(absoluteRemainingMs, SESSION_ROTATION_MAXIMUM_REMAINING_MS),
      };
      if (answer.outcome === "current") {
        deliver(plan(200, body));
        return;
      }
      const cookie = sessionCookie(secret, idleRemainingMs);
      // Under one second left: the new generation is never delivered (packet §4).
      deliver(cookie === null ? denied() : plan(200, body, cookie));
      return;
    }
    if (answer.outcome === "reuse_revoked" || answer.outcome === "denied") deliver(denied());
    else if (answer.outcome === "unknown") deliver(unknown());
    else deliver(unavailable());
  } catch (error) {
    if (delivered) throw Error("STANDALONE_ROTATION_TRANSPORT_UNKNOWN");
    // An aborted transport receives no late replacement delivery and no cookie.
    if (!signal?.aborted)
      deliver(
        invoked ? unknown() : unavailable(error instanceof LoginInputError ? error.status : 503),
        false,
      );
  }
}

// Source-owned local composition (the Node HTTPS adapter and labs): one 5 s attempt per
// request, the logout configuration, pool and executor. No caller authority is accepted;
// the rotated family derives only from this Request's cookie.
export async function createStandaloneRotation(dependencies: StandaloneLogoutDependencies) {
  let config: Readonly<StandaloneLogoutConfiguration>;
  let pool: StandaloneWorkspaceSqlPool, now: () => number;
  try {
    config = await parseStandaloneLogoutConfiguration(dependencies.configurationJson);
    ({ pool, now } = dependencies);
    if (!pool || typeof pool.connect !== "function" || typeof now !== "function")
      throw fixedFailure();
  } catch {
    throw Error("STANDALONE_ROTATION_CONFIGURATION_INVALID");
  }
  const dispatchRotation = async (request: Request, sink: RotationDeliverySink): Promise<void> => {
    if (!(request instanceof Request)) throw fixedFailure();
    const attempt = createLoginAttempt(now, request.signal, 5000);
    try {
      await dispatch(request, sink, attempt, config, pool);
    } finally {
      attempt.end();
    }
  };
  const fetch = async (request: Request): Promise<Response> => {
    let response: Response | undefined;
    await dispatchRotation(request, (output) => {
      const headers = new Headers(
        output.headers.map(([name, value]) => [name, value] as [string, string]),
      );
      for (const cookie of output.cookies) headers.append("Set-Cookie", cookie);
      response = new Response(output.bodyText, { status: output.status, headers });
    });
    if (!response) throw fixedFailure();
    return response;
  };
  return Object.freeze({ fetch, dispatch: dispatchRotation });
}
