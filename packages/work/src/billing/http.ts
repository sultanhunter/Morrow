import type { Core_ErrorEnvelope } from "@morrow/contracts";
import { validateDefinition } from "@morrow/contracts/validation";
import {
  billingCallToAction,
  billingEnvironments,
  environmentMode,
  type BillingDenial,
} from "@morrow/policy/billing-state";
import {
  WorkOutcomeUnknown,
  WorkReject,
  withWorkTransaction,
  type WorkSqlConnection,
  type WorkSqlConnector,
} from "../connection.js";
import { enterWorkContext, type WorkAuthority } from "../context.js";
import {
  guardWorkspaceRequest,
  WorkGuardError,
  workOrigin,
  type GuardedWorkspaceRequest,
  type WorkspaceRouteSpec,
} from "../http-guard.js";
import {
  authorizeBillingView,
  authorizePurchase,
  BillingCommandRejected,
  BillingDenied,
  billingRequestDigest,
  currentOffers,
  decideBilling,
  openCheckout,
  openPortal,
  parseCheckoutBody,
  parsePortalBody,
  readBillingContext,
  requirePurchase,
  type BillingCommandRejection,
} from "./commands.js";
import type { BillingBrokerPort, BillingEnvironmentName } from "./port.js";
import { subscriptionEntry } from "./terms.js";

// The billing HTTP API (M5 PR-1; P18.T01a; docs/contracts/billing-api.md). Routes under
// /workspace/:ws/billing on the api Worker's origin, for Morrow's own SPA: the billing view
// and, under the one purchase prefix /workspace/:ws/billing/morrow/, the plans, checkout and
// portal. One connection per request and a 5 s database deadline; the broker calls run
// after the commit, by operation id only. Never Set-Cookie, never CORS; one fixed log line.

export interface BillingApiDependencies {
  readonly origin: string;
  readonly connector: WorkSqlConnector;
  readonly environment: BillingEnvironmentName;
  /**
   * null: no broker Stripe adapters, which is the deployed api while the Stripe switch is off
   * (owner decision (c), 2026-10-21). Checkout and portal then answer 503 unavailable before
   * any database access or broker call, and the plans offer neither action; the billing view
   * (plan, credits, period) still reads the database.
   */
  readonly broker: BillingBrokerPort | null;
  readonly now: () => number;
}
type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;
export interface BillingRoute extends WorkspaceRouteSpec {
  readonly key: "GET " | "GET /morrow/plans" | "POST /morrow/checkout" | "POST /morrow/portal";
}
const route = (method: "GET" | "POST", pattern: string): BillingRoute =>
  Object.freeze({
    method,
    pattern,
    query: Object.freeze([]),
    key: `${method} ${pattern}` as BillingRoute["key"],
  });
/** Every route under /workspace/:ws/billing, shared with the conformance harness. */
export const billingRoutes: readonly BillingRoute[] = Object.freeze([
  route("GET", ""),
  route("GET", "/morrow/plans"),
  route("POST", "/morrow/checkout"),
  route("POST", "/morrow/portal"),
]);
export const billingBodyLimitBytes = 1024;
// The broker's own budget for one Stripe method (apps/api/src/broker-client.ts races it
// with a 500 ms RPC allowance). The request's abort covers the 5 s database phase and the
// two sequential broker calls of a first checkout (the customer, then the session) with a
// second to spare, so a slow but successful pair is never cut short into "uncertain".
const brokerBudgetMs = 8000;
const databaseMs = 5000;
export const billingRequestAbortMs = databaseMs + 2 * (brokerBudgetMs + 500) + 1000;

type Envelope = readonly [
  number,
  Core_ErrorEnvelope["code"],
  Core_ErrorEnvelope["retryClass"],
  string,
];
const fixed = Object.freeze({
  unauthenticated: [401, "denied", "never", "Sign in to continue."],
  invalid: [400, "missing_input", "never", "The request is not valid."],
  guard_denied: [403, "denied", "never", "This request is not permitted."],
  denied: [403, "denied", "never", "This operation is not permitted."],
  grant_overflow: [403, "denied", "never", "Current authority cannot be evaluated."],
  not_found: [404, "denied", "never", "The record was not found."],
  method_not_allowed: [405, "denied", "never", "This method is not allowed."],
  stale_authority: [
    409,
    "conflict",
    "recheck_before_retry",
    "Current authority changed. Retry the request.",
  ],
  command_conflict: [
    409,
    "conflict",
    "never",
    "This idempotency key was already used for a different request.",
  ],
  terms_conflict: [
    409,
    "conflict",
    "recheck_before_retry",
    "This plan is not available. Review the plans again.",
  ],
  checkout_conflict: [
    409,
    "conflict",
    "recheck_before_retry",
    "A checkout is already in progress for this workspace.",
  ],
  customer_missing: [
    409,
    "conflict",
    "recheck_before_retry",
    "Billing is not set up for this workspace yet.",
  ],
  // The workspace's Stripe customer setup is held for the operator (Stripe proved neither
  // outcome): retrying cannot help until Morrow support resolves it.
  customer_held: [
    409,
    "conflict",
    "never",
    "Billing setup for this workspace needs attention from Morrow support.",
  ],
  provider_failed: [
    409,
    "conflict",
    "never",
    "The billing provider could not start this. Try again.",
  ],
  checkout_closed: [409, "conflict", "never", "This checkout has ended. Start a new one."],
  unavailable: [503, "unavailable", "recheck_before_retry", "Billing is temporarily unavailable."],
  unavailable_read: [503, "unavailable", "safe_read_retry", "Billing is temporarily unavailable."],
  uncertain: [
    503,
    "uncertain",
    "reconcile_before_retry",
    "The outcome is unknown. Retry with the same idempotency key.",
  ],
} satisfies Record<string, Envelope>);
type FixedKind = keyof typeof fixed;
const headers = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
}
function envelope(
  [status, code, retryClass, safeMessage]: Envelope,
  correlationId: string,
  operationId: string | null = null,
  allow?: string,
): Response {
  const body: Core_ErrorEnvelope = {
    schemaVersion: 1,
    code,
    retryClass,
    safeMessage,
    correlationId,
    operationId,
    retryAfterSeconds: null,
    inputRequestIds: [],
  };
  if (!validateDefinition("core", "ErrorEnvelope", body)) throw Error("BILLING_ERROR_INVALID");
  return json(status, body, allow ? { Allow: allow } : {});
}
/** A billing denial (§9): its fixed envelope; denied 403, conflicts 409, unavailable 503. */
function billingDenialResponse(denial: BillingDenial, correlationId: string): Response {
  const e = denial.envelope;
  const status = e.code === "denied" ? 403 : e.code === "unavailable" ? 503 : 409;
  return envelope([status, e.code, e.retryClass, e.safeMessage], correlationId);
}
const rejectionKind: Readonly<Record<BillingCommandRejection, FixedKind>> = Object.freeze({
  invalid: "invalid",
  ineligible: "unauthenticated",
  command_conflict: "command_conflict",
  stale_authority: "stale_authority",
  route_conflict: "denied",
  terms_conflict: "terms_conflict",
  checkout_conflict: "checkout_conflict",
  customer_missing: "customer_missing",
  customer_held: "customer_held",
});

function dependencies(value: BillingApiDependencies): BillingApiDependencies {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.now !== "function" ||
    !value.connector ||
    typeof value.connector.open !== "function" ||
    !(billingEnvironments as readonly unknown[]).includes(value.environment) ||
    (value.broker !== null &&
      (typeof value.broker !== "object" ||
        ["customerEnsure", "checkoutCreate", "portalCreate", "webhookVerify"].some(
          (m) => typeof (value.broker as unknown as Record<string, unknown>)[m] !== "function",
        )))
  )
    throw Error("BILLING_API_CONFIGURATION_INVALID");
  const connector = value.connector;
  const now = value.now;
  return Object.freeze({
    origin: workOrigin(value.origin),
    connector: Object.freeze({ open: connector.open.bind(connector) }),
    environment: value.environment,
    broker: value.broker,
    now: () => Reflect.apply(now, undefined, []) as number,
  });
}

interface Outcome {
  readonly log: { route: string; outcome: string };
  readonly response: Response;
}

// No dependencies: every request is 401 with no network or database access.
export function createBillingApiHandler(d?: BillingApiDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(request: Request, ctx: Context, correlationId: string): Promise<Outcome> {
    const log = { route: "unmatched", outcome: "unbound" };
    if (!configured) return { log, response: envelope(fixed.unauthenticated, correlationId) };
    const start = configured.now();
    if (!Number.isSafeInteger(start)) throw Error("BILLING_CLOCK_INVALID");
    const deadlineMs = start + databaseMs;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), billingRequestAbortMs);
    const stop = () => abort.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    let read = request.method === "GET";
    const respond = (kind: FixedKind, outcome: string, operationId: string | null = null) => {
      log.outcome = outcome;
      return { log, response: envelope(fixed[kind], correlationId, operationId) };
    };
    try {
      let g: GuardedWorkspaceRequest<BillingRoute>;
      try {
        g = await guardWorkspaceRequest(
          configured.origin,
          "billing",
          billingRoutes,
          request,
          abort.signal,
          {
            bodyLimitBytes: billingBodyLimitBytes,
          },
        );
      } catch (error) {
        if (!(error instanceof WorkGuardError)) throw error;
        log.outcome = "guard_" + error.status;
        const kind: FixedKind =
          error.status === 401
            ? "unauthenticated"
            : error.status === 400
              ? "invalid"
              : error.status === 404
                ? "not_found"
                : error.status === 405
                  ? "method_not_allowed"
                  : "guard_denied";
        return { log, response: envelope(fixed[kind], correlationId, null, error.allow) };
      }
      log.route = g.route.key;
      read = g.route.method === "GET";
      // Step 1, before any connection: the closed body and its digest.
      let checkout: { readonly priceKey: string } | null = null;
      let digest: string | null = null;
      if (g.route.key === "POST /morrow/checkout") {
        checkout = parseCheckoutBody(g.body);
        if (!checkout) return respond("invalid", "invalid");
        digest = await billingRequestDigest("checkout", g.workspaceId, checkout);
      } else if (g.route.key === "POST /morrow/portal") {
        if (!parsePortalBody(g.body)) return respond("invalid", "invalid");
        digest = await billingRequestDigest("portal", g.workspaceId, {});
      }
      if (!read && !configured.broker) return respond("unavailable", "stripe_off");
      let connection: WorkSqlConnection;
      try {
        connection = await configured.connector.open({
          signal: abort.signal,
          deadlineMs,
          waitUntil: (p) => ctx.waitUntil(p),
        });
      } catch {
        return respond(read ? "unavailable_read" : "unavailable", "unavailable");
      }
      const options = { readOnly: read, deadlineMs, signal: abort.signal, now: configured.now };
      const context = async (tx: Parameters<Parameters<typeof withWorkTransaction>[2]>[0]) => {
        const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
        if (a === "ineligible") throw new WorkReject("unauthenticated");
        if (a === "grant_overflow") throw new WorkReject("grant_overflow");
        return a as WorkAuthority;
      };
      let committed:
        | { kind: "view"; body: Record<string, unknown> }
        | {
            kind: "checkout";
            outcome: string;
            customerOperationId: string | null;
            checkoutOperationId: string;
          }
        | { kind: "portal"; outcome: string; operationId: string };
      try {
        committed = await withWorkTransaction(connection, options, async (tx) => {
          const a = await context(tx);
          if (g.route.key === "GET ") {
            await authorizeBillingView(a);
            const c = await readBillingContext(tx, a, configured.environment);
            const mayPurchase = await decideBilling(a, "governance.billing.manage", "view");
            return { kind: "view" as const, body: billingView(c, mayPurchase) };
          }
          if (g.route.key === "GET /morrow/plans") {
            if (!(await decideBilling(a, "governance.billing.manage", "view")))
              throw new WorkReject("denied");
            const c = await readBillingContext(tx, a, configured.environment);
            const actions = requirePurchase(c, "GET /morrow/plans");
            // Only what POST /morrow/checkout can perform: the guard's subscribe, and
            // cmd_checkout_open's own precondition (an unfixed website route, never bound,
            // with no association) and no customer setup held for the operator. With the
            // Stripe switch off neither purchase can run, so neither is offered.
            const stripeOn = configured.broker !== null;
            const subscribe =
              stripeOn &&
              actions.includes("subscribe") &&
              checkoutAdmissible(c) &&
              !c.read.setupHold;
            return {
              kind: "view" as const,
              body: {
                termsRevision: c.terms?.termsRevision ?? null,
                offers: subscribe ? currentOffers(c.terms, configured.environment) : [],
                actions: {
                  subscribe,
                  billingPortal: stripeOn && actions.includes("billing_portal"),
                },
              },
            };
          }
          if (g.route.key === "POST /morrow/checkout") {
            const priceKey = checkout!.priceKey;
            await authorizePurchase(a, { action: "subscribe", priceKey });
            const c = await readBillingContext(tx, a, configured.environment);
            requirePurchase(c, "POST /morrow/checkout");
            const route = c.read.facts.route;
            const entry = c.terms
              ? subscriptionEntry(c.terms.terms, priceKey, environmentMode(configured.environment))
              : null;
            if (!c.terms || !entry || !route) {
              tx.rollbackOnly();
              // No route row is a route refusal; no terms revision, or a price outside it,
              // is a terms conflict (recheck the plans), never a route refusal.
              throw new BillingCommandRejected(route ? "terms_conflict" : "route_conflict");
            }
            const opened = await openCheckout(tx, {
              key: g.commandId!,
              digest: digest!,
              correlationId,
              priceKey,
              termsRevision: c.terms.termsRevision,
              routeRevision: route.revision,
            });
            return {
              kind: "checkout" as const,
              outcome: opened.outcome,
              customerOperationId: opened.customerOperationId,
              checkoutOperationId: opened.checkoutOperationId,
            };
          }
          await authorizePurchase(a, { action: "billing_portal", priceKey: null });
          const c = await readBillingContext(tx, a, configured.environment);
          requirePurchase(c, "POST /morrow/portal");
          const opened = await openPortal(tx, {
            key: g.commandId!,
            digest: digest!,
            correlationId,
          });
          return {
            kind: "portal" as const,
            outcome: opened.outcome,
            operationId: opened.operationId,
          };
        });
      } finally {
        await connection.close().catch(() => {});
      }
      if (committed.kind === "view") {
        log.outcome = "read";
        return { log, response: json(200, { schemaVersion: 1, ...committed.body }) };
      }
      // After the commit: the broker, by operation id only. Any failure here leaves the
      // operation for the same key's retry to reconcile (never a new one).
      const broker = configured.broker!;
      const status = committed.outcome === "applied" ? 201 : 200;
      if (committed.kind === "checkout") {
        const opId = committed.checkoutOperationId;
        try {
          if (committed.customerOperationId) {
            const customer = await broker.customerEnsure(
              committed.customerOperationId,
              abort.signal,
            );
            if (customer.outcome === "failed")
              return respond("provider_failed", "customer_failed", opId);
            if (customer.outcome === "held") return respond("customer_held", "customer_held", opId);
            if (customer.outcome !== "verified")
              return respond("uncertain", "customer_" + customer.outcome, opId);
          }
          const session = await broker.checkoutCreate(opId, abort.signal);
          if (
            session.outcome === "verified" &&
            session.checkoutUrl &&
            session.expiresAtMs !== null
          ) {
            log.outcome = committed.outcome;
            return {
              log,
              response: json(status, {
                schemaVersion: 1,
                operationId: opId,
                checkoutUrl: session.checkoutUrl,
                expiresAt: new Date(session.expiresAtMs).toISOString(),
              }),
            };
          }
          if (session.outcome === "failed")
            return respond("provider_failed", "checkout_failed", opId);
          if (session.outcome === "closed")
            return respond("checkout_closed", "checkout_closed", opId);
          return respond("uncertain", "checkout_" + session.outcome, opId);
        } catch {
          return respond("uncertain", "broker_held", opId);
        }
      }
      try {
        const portal = await broker.portalCreate(committed.operationId, abort.signal);
        if (portal.outcome === "verified" && portal.portalUrl) {
          log.outcome = committed.outcome;
          return {
            log,
            response: json(status, {
              schemaVersion: 1,
              operationId: committed.operationId,
              portalUrl: portal.portalUrl,
            }),
          };
        }
        if (portal.outcome === "failed")
          return respond("provider_failed", "portal_failed", committed.operationId);
        return respond("uncertain", "portal_" + portal.outcome, committed.operationId);
      } catch {
        return respond("uncertain", "broker_held", committed.operationId);
      }
    } catch (error) {
      if (error instanceof BillingDenied) {
        log.outcome = error.denial.code;
        return { log, response: billingDenialResponse(error.denial, correlationId) };
      }
      if (error instanceof BillingCommandRejected)
        return respond(rejectionKind[error.outcome], error.outcome);
      if (error instanceof WorkReject) {
        const kind: FixedKind =
          error.reason === "unauthenticated" ||
          error.reason === "invalid" ||
          error.reason === "denied" ||
          error.reason === "grant_overflow" ||
          error.reason === "stale_authority" ||
          error.reason === "command_conflict"
            ? error.reason
            : read
              ? "unavailable_read"
              : "unavailable";
        return respond(kind, error.reason);
      }
      if (error instanceof WorkOutcomeUnknown) return respond("uncertain", "uncertain");
      return respond(read ? "unavailable_read" : "unavailable", "unavailable");
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", stop);
    }
  }
  return Object.freeze({
    async fetch(request: Request, _env: unknown, ctx: Context): Promise<Response> {
      const correlationId = crypto.randomUUID();
      let log = { route: "unmatched", outcome: "unavailable" };
      try {
        if (!(request instanceof Request)) {
          log.outcome = "invalid";
          return envelope(fixed.invalid, correlationId);
        }
        const handled = await handle(request, ctx, correlationId);
        log = handled.log;
        return handled.response;
      } catch {
        return envelope(fixed.unavailable, correlationId);
      } finally {
        console.log(JSON.stringify({ event: "morrow_billing", ...log, correlationId }));
      }
    },
  });
}

/**
 * cmd_checkout_open's route precondition, as the facts show it: the workspace's route row
 * exists and is unfixed, its origin is the website, it was never bound to a store, and no
 * store is associated. Anything else the definer refuses as route_conflict.
 */
function checkoutAdmissible(c: Awaited<ReturnType<typeof readBillingContext>>): boolean {
  const route = c.read.facts.route;
  return (
    route !== null &&
    route.route === null &&
    route.origin === "website" &&
    route.shopifyBoundAt === null &&
    c.read.facts.associations.length === 0
  );
}

/**
 * The billing view: the phase and state, the plan's status and validity, the credits and
 * the billing period, any checkout in progress, a customer setup held for the operator
 * (its operation id, the reference for Morrow support), and the one call to action, which
 * comes only from billingCallToAction (P01.T04a §9). No provider id, price or URL.
 */
function billingView(c: Awaited<ReturnType<typeof readBillingContext>>, mayPurchase: boolean) {
  const s = c.state;
  const snapshot = c.read.snapshot;
  const wallet = c.read.wallet;
  return {
    phase: s.phase,
    state: s.state,
    plan: snapshot
      ? { status: snapshot.status, validUntil: snapshot.validUntil }
      : c.read.account
        ? { status: c.read.account.status, validUntil: null }
        : null,
    credits: wallet
      ? { available: wallet.available, reserved: wallet.reserved, consumed: wallet.consumed }
      : null,
    billingPeriod: c.read.billingPeriod,
    checkout: c.read.intent
      ? { status: c.read.intent.status, expiresAt: c.read.intent.expiresAt }
      : null,
    setupHold: c.read.setupHold
      ? { operationId: c.read.setupHold.operationId, heldAt: c.read.setupHold.heldAt }
      : null,
    callToAction: mayPurchase ? billingCallToAction(s) : { kind: "none" },
  };
}
