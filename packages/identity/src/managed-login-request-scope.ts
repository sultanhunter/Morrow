import type { LoginAttempt, LoginControl } from "./standalone-login-protocol.js";

// Private composition identities, never package entrypoints or serialized claims.
declare const scopeBrand: unique symbol;
declare const ownerBrand: unique symbol;
export type ManagedLoginRequestScope = Readonly<{ readonly [scopeBrand]: true }>;
export type ManagedLoginRequestOwnerToken = Readonly<{ readonly [ownerBrand]: true }>;
type Context = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
type Metrics = {
  publicationAttempts: number;
  publicationAccepted: number;
  publicationFailures: number;
  duplicatePublicationAttempts: number;
  publishedPending: number;
  publishedSettled: number;
  ownerMismatches: number;
  namespaceMismatches: number;
  businessDenials: number;
};
type Owner = {
  token: ManagedLoginRequestOwnerToken;
  attempt: LoginAttempt;
  context: Context;
  waitUntil: Context["waitUntil"];
  namespace?: string;
  metrics: Metrics;
};
const owners = new WeakMap<object, Owner>();
const publications = new WeakMap<Promise<void>, { scope: object; accepted: boolean }>();
const held = () => Error("MANAGED_LOGIN_REQUEST_SCOPE_HELD");
const digest = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);

function owner(scope: ManagedLoginRequestScope, token: ManagedLoginRequestOwnerToken): Owner {
  const found = typeof scope === "object" && scope !== null ? owners.get(scope) : undefined;
  if (!found) throw held();
  if (found.token !== token) {
    found.metrics.ownerMismatches++;
    throw held();
  }
  return found;
}

export function createManagedLoginRequestOwner(
  actualCtx: Context,
  originalAttempt: LoginAttempt,
): Readonly<{
  scope: ManagedLoginRequestScope;
  ownerToken: ManagedLoginRequestOwnerToken;
}> {
  try {
    // Provenance comes from the actual module entry. A method shape is not a
    // nominal check for workerd; capture the native method and receiver once.
    const waitUntil = actualCtx.waitUntil;
    if (typeof waitUntil !== "function") throw held();
    originalAttempt.check();
    const scope = Object.freeze(Object.create(null)) as ManagedLoginRequestScope;
    const ownerToken = Object.freeze(Object.create(null)) as ManagedLoginRequestOwnerToken;
    owners.set(scope, {
      token: ownerToken,
      attempt: originalAttempt,
      context: actualCtx,
      waitUntil,
      metrics: {
        publicationAttempts: 0,
        publicationAccepted: 0,
        publicationFailures: 0,
        duplicatePublicationAttempts: 0,
        publishedPending: 0,
        publishedSettled: 0,
        ownerMismatches: 0,
        namespaceMismatches: 0,
        businessDenials: 0,
      },
    });
    return Object.freeze({ scope, ownerToken });
  } catch {
    throw held();
  }
}

export function bindManagedLoginRequestNamespace(
  scope: ManagedLoginRequestScope,
  ownerToken: ManagedLoginRequestOwnerToken,
  configurationDigest: string,
): void {
  const found = owner(scope, ownerToken);
  if (found.namespace !== undefined || !digest(configurationDigest)) {
    found.metrics.namespaceMismatches++;
    throw held();
  }
  try {
    found.attempt.check();
  } catch {
    found.metrics.businessDenials++;
    throw held();
  }
  found.namespace = configurationDigest;
}

export function assertManagedLoginRequestOwner(
  scope: ManagedLoginRequestScope,
  ownerToken: ManagedLoginRequestOwnerToken,
  configurationDigest: string,
): Readonly<LoginControl> {
  const found = owner(scope, ownerToken);
  if (!digest(configurationDigest) || found.namespace !== configurationDigest) {
    found.metrics.namespaceMismatches++;
    throw held();
  }
  try {
    found.attempt.check();
    const current = found.attempt.control();
    return Object.freeze({ deadlineMs: current.deadlineMs, signal: current.signal });
  } catch {
    found.metrics.businessDenials++;
    throw held();
  }
}

export function publishManagedLoginCleanup(
  scope: ManagedLoginRequestScope,
  ownerToken: ManagedLoginRequestOwnerToken,
  exactReleasePromise: Promise<void>,
): void {
  const found = owner(scope, ownerToken);
  // Already-owned disposal may be published after parent abort/end. It cannot
  // require renewed business authority or create another normal-work budget.
  if (found.namespace === undefined || !(exactReleasePromise instanceof Promise)) throw held();
  const previous = publications.get(exactReleasePromise);
  if (previous !== undefined) {
    if (previous.scope !== scope) {
      found.metrics.ownerMismatches++;
      throw held();
    }
    found.metrics.duplicatePublicationAttempts++;
    if (!previous.accepted) throw held();
    return;
  }
  const publication = { scope, accepted: false };
  publications.set(exactReleasePromise, publication);
  found.metrics.publicationAttempts++;
  found.metrics.publishedPending++;
  const settled = (outcome: "fulfilled" | "rejected") => {
    found.metrics.publishedPending--;
    found.metrics.publishedSettled++;
    try {
      console.debug(
        JSON.stringify({
          event: "morrow_managed_login_cleanup_settled",
          outcome,
          ...found.metrics,
        }),
      );
    } catch {
      // Telemetry cannot replace the primary outcome or renew cleanup authority.
    }
  };
  // Observe settlement without replacing the exact registered Promise.
  void exactReleasePromise.then(
    () => settled("fulfilled"),
    () => settled("rejected"),
  );
  try {
    Reflect.apply(found.waitUntil, found.context, [exactReleasePromise]);
    publication.accepted = true;
    found.metrics.publicationAccepted++;
  } catch {
    found.metrics.publicationFailures++;
    throw held();
  }
}

export function snapshotManagedLoginRequestMetrics(
  scope: ManagedLoginRequestScope,
  ownerToken: ManagedLoginRequestOwnerToken,
): Readonly<Metrics> {
  // Disposal observations remain available after request authority ends.
  return Object.freeze({ ...owner(scope, ownerToken).metrics });
}
