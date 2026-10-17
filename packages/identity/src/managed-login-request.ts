import {
  captureManagedLoginConstruction,
  createManagedStandaloneLoginSetup,
  dispatchStandaloneLoginWithAttempt,
  snapshotManagedStandaloneLoginSetup,
  standaloneLoginResponseFromPlan,
  type ManagedLoginDependencies,
} from "./standalone-login.js";
import {
  createManagedLoginRequestOwner,
  type ManagedLoginRequestScope,
  type ManagedLoginRequestOwnerToken,
} from "./managed-login-request-scope.js";
import {
  createLoginAttempt,
  loginFailure,
  type LoginAttempt,
} from "./standalone-login-protocol.js";

type Context = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
type ResponseMetrics = Readonly<
  ReturnType<typeof snapshotManagedStandaloneLoginSetup> & {
    enteredAtMs: number;
    initialDeadlineMs: number;
    finalDeadlineMs: number;
    attemptEnded: boolean;
  }
>;
// Each value contains closed primitive snapshots only. No scope, context, client,
// attempt or pending promise is kept by a handler or response observation cache.
const responses = new WeakMap<Response, ResponseMetrics>();

export function createWorkersManagedLoginHandler(dependencies: ManagedLoginDependencies) {
  const captured = captureManagedLoginConstruction(dependencies);
  const fetch = async (request: Request, _env: unknown, actualCtx: Context): Promise<Response> => {
    let attempt: LoginAttempt | undefined,
      scope: ManagedLoginRequestScope | undefined,
      ownerToken: ManagedLoginRequestOwnerToken | undefined,
      entryError: unknown,
      enteredAtMs = 0,
      initialDeadlineMs = 0;
    try {
      if (!(request instanceof Request)) throw loginFailure();
      // Entry authority is captured before asynchronous request work. Common dispatch
      // classifies and narrows this same attempt before any asynchronous setup.
      attempt = createLoginAttempt(captured.now, request.signal, 25000);
      initialDeadlineMs = attempt.control().deadlineMs;
      enteredAtMs = initialDeadlineMs - 25000;
      ({ scope, ownerToken } = createManagedLoginRequestOwner(actualCtx, attempt));
    } catch (error) {
      entryError = error;
    }
    const setup = createManagedStandaloneLoginSetup(
      captured.construction,
      enteredAtMs,
      scope,
      ownerToken,
      entryError,
    );
    let response: Response | undefined;
    try {
      await dispatchStandaloneLoginWithAttempt(
        request,
        (output) => {
          response = standaloneLoginResponseFromPlan(output);
        },
        attempt,
        setup,
      );
    } finally {
      attempt?.end();
    }
    if (!response) throw loginFailure();
    const metrics = Object.freeze({
      ...snapshotManagedStandaloneLoginSetup(setup),
      enteredAtMs,
      initialDeadlineMs,
      finalDeadlineMs: attempt?.control().deadlineMs ?? 0,
      attemptEnded: attempt !== undefined,
    });
    responses.set(response, metrics);
    return response;
  };
  return Object.freeze({ fetch });
}

export function snapshotManagedLoginResponseMetrics(response: Response): ResponseMetrics {
  const metrics = responses.get(response);
  if (!metrics) throw loginFailure();
  return metrics;
}
