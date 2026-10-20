import type { Current_Grant } from "@morrow/contracts";
import {
  validateCapabilityInput,
  validateCurrentBillingDefinition,
} from "@morrow/contracts/validation";
import { createHumanPolicyService, type HumanAuthority } from "@morrow/policy";
import {
  environmentMode,
  parseWorkspaceBillingFacts,
  workspaceBillingState,
  type BillingDenial,
  type BillingEnvironment,
  type WorkspaceBillingState,
} from "@morrow/policy/billing-state";
import { WorkReject, type WorkRejection, type WorkTx } from "../connection.js";
import type { WorkAuthority } from "../context.js";
import { canonicalJson, sha256Hex } from "../digest.js";
import { createBillingFactsReader, type BillingFactsRead } from "./facts.js";
import { guardPurchase, type MorrowPurchaseRouteKey } from "./purchase-guard.js";
import { subscriptionEntry, termsFromRow, type BillingTermsRevision } from "./terms.js";

// Billing commands (M5 PR-1; P18.T01a). Authority first, in code: the policy kernel decides
// governance.billing.manage (human_only, never paid work, so entitlementAllowed is the
// literal false), then the purchase guard on the server-held route state, then one definer
// that rechecks freshness and the route under the route row's lock. Only after the commit
// does the api ask the broker to act, by operation id only (ADR-0022 item 7).

export type { BillingBrokerPort } from "./port.js";

/**
 * A decided purchase-guard denial, mapped by the HTTP layer to its BILLING_DENIAL_ENVELOPES
 * row. A WorkReject, so withWorkTransaction passes it through and persists nothing.
 */
export class BillingDenied extends WorkReject {
  constructor(readonly denial: BillingDenial) {
    super("denied");
    this.name = "BillingDenied";
  }
}

const billingFields = Object.freeze(["action", "priceKey"]);
const usageFields = Object.freeze(["period", "scope"]);
type BillingCapability = "governance.billing.manage" | "governance.usage.read";

/** One kernel decision on the session's workspace resource; never paid work. */
export async function decideBilling(
  a: WorkAuthority,
  capabilityId: BillingCapability,
  verb: "view" | "execute",
): Promise<boolean> {
  const authority: HumanAuthority = {
    actor: a.actor,
    policyRevision: a.policyRevision,
    grantsRevision: a.policyRevision,
    principalActive: true,
    organizationActive: true,
    workspaceActive: true,
    membershipActive: true,
    sessionCurrent: true,
    resource: a.resource,
    accountId: null,
    providerAllowed: true,
    entitlementAllowed: false,
    grants: a.grants as readonly Current_Grant[],
  };
  const service = createHumanPolicyService(
    { readCurrent: async () => authority },
    () => new Date(a.databaseNowMs),
  );
  const result = await service.decide({
    capabilityId,
    verb,
    resource: a.resource,
    accountId: null,
    fields: [...(capabilityId === "governance.billing.manage" ? billingFields : usageFields)],
  });
  return result.decision.allowed;
}

/** GET /billing: view on governance.billing.manage or governance.usage.read. */
export async function authorizeBillingView(a: WorkAuthority): Promise<void> {
  if (
    (await decideBilling(a, "governance.billing.manage", "view")) ||
    (await decideBilling(a, "governance.usage.read", "view"))
  )
    return;
  throw new WorkReject("denied");
}

export interface BillingContext {
  readonly read: BillingFactsRead;
  readonly state: WorkspaceBillingState;
  readonly terms: BillingTermsRevision | null;
}
/**
 * The session tenant's billing state at the database clock, and the current terms. Any
 * reader, parse or terms failure is unavailable (fail closed), before any command.
 */
export async function readBillingContext(
  tx: WorkTx,
  a: WorkAuthority,
  environment: BillingEnvironment,
): Promise<BillingContext> {
  try {
    const reader = createBillingFactsReader((name, values) => tx.run(name, values));
    const scope = { organizationId: a.actor.organizationId, workspaceId: a.resource.workspaceId };
    const read = await reader.read(scope);
    const state = workspaceBillingState(
      parseWorkspaceBillingFacts(read.facts, scope, environment),
      new Date(a.databaseNowMs).toISOString(),
      environment,
    );
    const rows = await tx.run("billingTermsLatest", []);
    if (rows.length > 1) throw Error();
    const terms = rows.length ? termsFromRow(rows[0]!) : null;
    return Object.freeze({ read, state, terms });
  } catch (error) {
    if (error instanceof WorkReject) throw error;
    throw new WorkReject("unavailable");
  }
}

/** The purchase guard on the context's state: the allowed actions, or a BillingDenied. */
export function requirePurchase(context: BillingContext, key: MorrowPurchaseRouteKey) {
  const decided = guardPurchase(context.state, key);
  if (!decided.allowed) throw new BillingDenied(decided.denial);
  return decided.actions;
}

/** The offers of the current terms in this environment's mode, with their credit units. */
export function currentOffers(terms: BillingTermsRevision | null, environment: BillingEnvironment) {
  if (!terms) return [];
  const mode = environmentMode(environment);
  return terms.offers.flatMap((offer) => {
    const entry = subscriptionEntry(terms.terms, offer.priceKey, mode);
    return entry && entry.currency === offer.currency
      ? [
          {
            priceKey: offer.priceKey,
            amount: `${offer.unitAmount.slice(0, -2) || "0"}.${offer.unitAmount.slice(-2).padStart(2, "0")}`,
            currency: offer.currency,
            interval: offer.interval,
            creditUnits: entry.creditUnits,
          },
        ]
      : [];
  });
}

/** The closed checkout body {priceKey}: exactly one key, a Stripe price key. */
export function parseCheckoutBody(body: unknown): { readonly priceKey: string } | null {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).join(",") !== "priceKey"
  )
    return null;
  const priceKey = (body as { priceKey: unknown }).priceKey;
  return validateCurrentBillingDefinition("StripePriceKey", priceKey)
    ? Object.freeze({ priceKey: priceKey as string })
    : null;
}
/** The portal body is the empty object. */
export const parsePortalBody = (body: unknown): boolean =>
  body !== null &&
  typeof body === "object" &&
  !Array.isArray(body) &&
  Object.keys(body).length === 0;

export type BillingCommandType = "checkout" | "portal";
/** The request digest: canonical JSON of the command, workspace and body (replay and conflict). */
export const billingRequestDigest = (
  type: BillingCommandType,
  workspaceId: string,
  body: unknown,
) => sha256Hex(canonicalJson(["morrow.billing.command", 1, type, workspaceId, body]));

/** Execute on governance.billing.manage with the server-built input, then the purchase guard. */
export async function authorizePurchase(
  a: WorkAuthority,
  input: { readonly action: "subscribe" | "billing_portal"; readonly priceKey: string | null },
): Promise<void> {
  if (!validateCapabilityInput("governance.billing.manage", input)) throw new WorkReject("invalid");
  if (!(await decideBilling(a, "governance.billing.manage", "execute")))
    throw new WorkReject("denied");
}

export interface CheckoutOpened {
  readonly outcome: "applied" | "replayed" | "reused";
  readonly intentId: string;
  readonly status: string;
  readonly customerOperationId: string | null;
  readonly checkoutOperationId: string;
  readonly expiresAt: string;
}
export type BillingCommandRejection =
  | "invalid"
  | "ineligible"
  | "command_conflict"
  | "stale_authority"
  | "route_conflict"
  | "terms_conflict"
  | "checkout_conflict"
  | "customer_missing";
const baseReason: Readonly<Record<BillingCommandRejection, WorkRejection>> = Object.freeze({
  invalid: "invalid",
  ineligible: "unauthenticated",
  command_conflict: "command_conflict",
  stale_authority: "stale_authority",
  route_conflict: "state_conflict",
  terms_conflict: "state_conflict",
  checkout_conflict: "state_conflict",
  customer_missing: "state_conflict",
});
/** A definer's decided refusal: the transaction rolls back and the HTTP layer maps it. */
export class BillingCommandRejected extends WorkReject {
  constructor(readonly outcome: BillingCommandRejection) {
    super(baseReason[outcome]);
    this.name = "BillingCommandRejected";
  }
}
const rejections: readonly string[] = [
  "invalid",
  "ineligible",
  "command_conflict",
  "stale_authority",
  "route_conflict",
  "terms_conflict",
  "checkout_conflict",
  "customer_missing",
];
// After markSubmitted: a decided refusal rolls back; any reply that is not a decided
// outcome stays an unknown outcome (withWorkTransaction), never success or denial.
function commandRow(
  tx: WorkTx,
  rows: readonly Readonly<Record<string, unknown>>[],
): {
  outcome: string;
  result: Record<string, unknown> | null;
} {
  const row = rows.length === 1 ? rows[0]! : null;
  if (
    !row ||
    Object.keys(row).sort().join(",") !== "outcome,result" ||
    typeof row.outcome !== "string"
  )
    throw new WorkReject("unavailable");
  if (rejections.includes(row.outcome)) {
    tx.rollbackOnly();
    throw new BillingCommandRejected(row.outcome as BillingCommandRejection);
  }
  if (typeof row.result !== "string") throw new WorkReject("unavailable");
  let result: unknown;
  try {
    result = JSON.parse(row.result);
  } catch {
    throw new WorkReject("unavailable");
  }
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new WorkReject("unavailable");
  return { outcome: row.outcome, result: result as Record<string, unknown> };
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

/** cmd_checkout_open after the guard: the definer's outcome, or a fixed rejection. */
export async function openCheckout(
  tx: WorkTx,
  values: {
    readonly key: string;
    readonly digest: string;
    readonly correlationId: string;
    readonly priceKey: string;
    readonly termsRevision: number;
    readonly routeRevision: number;
  },
): Promise<CheckoutOpened> {
  tx.markSubmitted();
  const { outcome, result } = commandRow(
    tx,
    await tx.run("cmdCheckoutOpen", [
      values.key,
      values.digest,
      values.correlationId,
      values.priceKey,
      String(values.termsRevision),
      String(values.routeRevision),
    ]),
  );
  const r = result!;
  if (
    !["applied", "replayed", "reused"].includes(outcome) ||
    Object.keys(r).sort().join(",") !==
      "checkoutOperationId,customerOperationId,expiresAt,intentId,status" ||
    !uuid(r.intentId) ||
    !uuid(r.checkoutOperationId) ||
    !(r.customerOperationId === null || uuid(r.customerOperationId)) ||
    typeof r.status !== "string" ||
    typeof r.expiresAt !== "string"
  )
    throw new WorkReject("unavailable");
  return Object.freeze({
    outcome: outcome as CheckoutOpened["outcome"],
    intentId: r.intentId,
    status: r.status,
    customerOperationId: r.customerOperationId as string | null,
    checkoutOperationId: r.checkoutOperationId,
    expiresAt: r.expiresAt,
  });
}

/** cmd_portal_open after the guard. */
export async function openPortal(
  tx: WorkTx,
  values: { readonly key: string; readonly digest: string; readonly correlationId: string },
): Promise<{ readonly outcome: "applied" | "replayed"; readonly operationId: string }> {
  tx.markSubmitted();
  const { outcome, result } = commandRow(
    tx,
    await tx.run("cmdPortalOpen", [values.key, values.digest, values.correlationId]),
  );
  const r = result!;
  if (
    !["applied", "replayed"].includes(outcome) ||
    Object.keys(r).join(",") !== "operationId" ||
    !uuid(r.operationId)
  )
    throw new WorkReject("unavailable");
  return Object.freeze({ outcome: outcome as "applied" | "replayed", operationId: r.operationId });
}
