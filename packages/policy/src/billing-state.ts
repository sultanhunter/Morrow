// Billing state library (P01.T04a §3, §5, §6; ADR-0015). Pure: no I/O, clock or
// randomness. The environment comes from the composition root and `now` from
// the caller's clock; facts come only from a trusted server reader, never from
// an HTTP body, checkout return, redirect parameter, plan handle, provider
// metadata, browser login or model output.
//
// PR-A added the §4.4 test entitlement seed branch (ADR-0015 follow-up decision
// OQ-2 (a)). PR-B adds the route library: the origin of a new workspace, the
// derived route phase, payer statuses and entitlement, purchase decisions and
// the one call to action, payment classification, canonical Shopify keys,
// provider status mapping, entitlement folding, the spending scope, payer
// selection, the denial table and `createBillingConstraintsReader`, which folds
// an accepted seed into the workspace state. Every result is frozen, and only
// facts and states this module issued are accepted back.
import type {
  Core_ActorRef,
  Core_Grant,
  CurrentBilling_BillingAccount,
  CurrentBilling_BillingRoute,
  CurrentBilling_BillingTerms,
  CurrentBilling_CostAllocation,
  CurrentBilling_EntitlementSnapshot,
  CurrentBilling_PaymentMode,
  CurrentBilling_PaymentReversal,
  CurrentBilling_TestEntitlementSeed,
  CurrentBilling_VerifiedPaymentEvent,
  CurrentBilling_WorkspaceBillingRoute,
} from "@morrow/contracts";
import { validateCurrentBillingDefinition, validateDefinition } from "@morrow/contracts/validation";
import { plainJson, closed, freezeJson } from "./json-boundary";
import { isPaidWork } from "./paid-work";
import { isCurrentGrant } from "./index";
import type { CurrentConstraintsReader, PermissionRequest } from "./index";

export type BillingEnvironment = "development" | "staging" | "production";
export const billingEnvironments: readonly BillingEnvironment[] = Object.freeze([
  "development",
  "staging",
  "production",
]);
/** The only environments whose readers accept a test entitlement seed. */
export const testSeedEnvironments: readonly BillingEnvironment[] = Object.freeze([
  "development",
  "staging",
]);

export class BillingBoundaryError extends Error {
  constructor(readonly code: "BILLING_INPUT_INVALID" | "BILLING_FACTS_INVALID") {
    super(code);
    this.name = "BillingBoundaryError";
  }
}

export interface BillingScope {
  readonly organizationId: string;
  readonly workspaceId: string;
}

/**
 * The one storeless payer an accepted seed gives. It is not a BillingAccount on
 * either route, holds no subscription and was never paid for: `creditUnits` is
 * the seed's cap, which reservations (P11.T04a) may not exceed.
 */
export interface TestSeedPayer {
  readonly kind: "test_seed";
  readonly seedId: string;
  readonly seedRevision: number;
  readonly mode: "test";
  readonly installationId: null;
  readonly storeId: null;
  readonly creditUnits: string;
  readonly validUntil: string;
}

/**
 * The seed branch's result. It never carries a route, an account, a grant or a
 * payment key: a seed fixes no route, creates no account and is never a payment.
 */
export type TestSeedEvaluation =
  | {
      readonly status: "accepted";
      readonly organizationId: string;
      readonly workspaceId: string;
      readonly environment: "development" | "staging";
      readonly coveredStoreIds: readonly string[];
      readonly payer: TestSeedPayer;
    }
  | {
      readonly status: "inactive";
      readonly reason: "SEED_NOT_YET_VALID" | "SEED_EXPIRED";
      readonly organizationId: string;
      readonly workspaceId: string;
      readonly environment: "development" | "staging";
    }
  | {
      readonly status: "refused";
      readonly reason: "SEED_REFUSED_IN_PRODUCTION";
      readonly organizationId: string;
      readonly workspaceId: string;
      readonly environment: "production";
    };

// Only evaluations, facts and states this module returned are accepted back; a
// hand-built object cannot entitle or be classified against.
const issued = new WeakSet<object>();
const issuedFacts = new WeakSet<object>();
const issuedStates = new WeakSet<object>();
const id = (value: unknown): value is string => validateDefinition("core", "Id", value);
const utcTime = (value: unknown): value is string =>
  validateDefinition("core", "UtcTime", value) && Number.isFinite(Date.parse(value as string));
const inputInvalid = () => new BillingBoundaryError("BILLING_INPUT_INVALID");
const factsInvalid = () => new BillingBoundaryError("BILLING_FACTS_INVALID");
const clone = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

function parseEnvironment(value: unknown): BillingEnvironment {
  if (typeof value !== "string" || !(billingEnvironments as readonly string[]).includes(value))
    throw inputInvalid();
  return value as BillingEnvironment;
}
function parseScope(value: unknown): BillingScope {
  if (!plainJson(value)) throw inputInvalid();
  // Copy once, then check and return only the copy.
  const scope = clone<Record<string, unknown>>(value);
  if (
    !closed(scope, ["organizationId", "workspaceId"]) ||
    !id(scope.organizationId) ||
    !id(scope.workspaceId)
  )
    throw inputInvalid();
  return { organizationId: scope.organizationId, workspaceId: scope.workspaceId };
}
function parseTime(value: unknown): string {
  if (!utcTime(value)) throw inputInvalid();
  return value;
}
function issue<T extends TestSeedEvaluation>(evaluation: T): T {
  const frozen = freezeJson(evaluation) as T;
  issued.add(frozen);
  return frozen;
}

/**
 * Evaluates one stored test entitlement seed for the workspace `scope` at `now`.
 * Production readers refuse every seed without reading it. In development and
 * staging a seed must be a valid TestEntitlementSeed of exactly this tenant with
 * `validFrom < validUntil`; it is accepted while `validFrom <= now < validUntil`.
 * Throws `BILLING_INPUT_INVALID` for a bad environment, scope or time and
 * `BILLING_FACTS_INVALID` for a malformed or foreign seed.
 */
export function evaluateTestEntitlementSeed(
  seed: unknown,
  scope: BillingScope,
  now: string,
  environment: BillingEnvironment,
): TestSeedEvaluation {
  const env = parseEnvironment(environment);
  const { organizationId, workspaceId } = parseScope(scope);
  if (env === "production")
    return issue({
      status: "refused",
      reason: "SEED_REFUSED_IN_PRODUCTION",
      organizationId,
      workspaceId,
      environment: env,
    });
  if (!utcTime(now)) throw inputInvalid();
  if (!plainJson(seed)) throw factsInvalid();
  // Isolate the caller's object, then validate the copy that is read.
  const record = clone<CurrentBilling_TestEntitlementSeed>(seed);
  if (!validateCurrentBillingDefinition("TestEntitlementSeed", record)) throw factsInvalid();
  const from = Date.parse(record.validFrom),
    until = Date.parse(record.validUntil),
    at = Date.parse(now);
  if (
    record.organizationId !== organizationId ||
    record.workspaceId !== workspaceId ||
    !Number.isFinite(from) ||
    !Number.isFinite(until) ||
    from >= until
  )
    throw factsInvalid();
  if (at < from || at >= until)
    return issue({
      status: "inactive",
      reason: at < from ? "SEED_NOT_YET_VALID" : "SEED_EXPIRED",
      organizationId,
      workspaceId,
      environment: env,
    });
  return issue({
    status: "accepted",
    organizationId,
    workspaceId,
    environment: env,
    coveredStoreIds: [...record.storeIds].sort(),
    payer: {
      kind: "test_seed",
      seedId: record.seedId,
      seedRevision: record.revision,
      mode: "test",
      installationId: null,
      storeId: null,
      creditUnits: record.creditUnits,
      validUntil: record.validUntil,
    },
  });
}

/**
 * Whether an accepted seed entitles `request` at `now`: `now` is before the
 * seed's `validUntil`, the tenant matches, and the request is storeless or on a
 * store the seed names. Callers read it only for paid work (`isPaidWork`); a
 * refused, inactive, expired or hand-built evaluation never entitles, so a
 * retained evaluation stops entitling when its seed expires. Throws
 * `BILLING_INPUT_INVALID` for a bad time.
 */
export function testSeedEntitles(
  evaluation: TestSeedEvaluation,
  request: PermissionRequest,
  now: string,
): boolean {
  if (!utcTime(now)) throw inputInvalid();
  if (!issued.has(evaluation) || evaluation.status !== "accepted") return false;
  if (Date.parse(now) >= Date.parse(evaluation.payer.validUntil)) return false;
  const resource = request.resource;
  if (
    resource.organizationId !== evaluation.organizationId ||
    resource.workspaceId !== evaluation.workspaceId
  )
    return false;
  return resource.storeId === null || evaluation.coveredStoreIds.includes(resource.storeId);
}

// ---------------------------------------------------------------------------
// Route model (§3) and origin (R1)
// ---------------------------------------------------------------------------

export type BillingRoute = CurrentBilling_BillingRoute;
export type PaymentMode = CurrentBilling_PaymentMode;
export type EntitlementStatus = CurrentBilling_EntitlementSnapshot["status"];
export type BillingOrigin = "website" | "shopify_install";
export type BillingPhase = "open" | "shopify_bound" | "morrow_direct" | "shopify_app_pricing";
export type PaymentKind = CurrentBilling_VerifiedPaymentEvent["kind"];

/** The mode an environment accepts: production only `live`, every other only `test` (R9). */
export const environmentMode = (environment: BillingEnvironment): PaymentMode =>
  parseEnvironment(environment) === "production" ? "live" : "test";

export type CreationFlow =
  | { readonly kind: "website_signup"; readonly installHandoffPending: boolean }
  | { readonly kind: "install_continuation" }
  | { readonly kind: "workspace_in_existing_organization" }
  | { readonly kind: "operator_seed" }
  | { readonly kind: "fixture" };

/**
 * R1: the origin a creating transaction writes. `website` only for the P05.T01x
 * signup flow with no pending install handoff (expired handoffs are kept, so
 * they are still pending here); `shopify_install` for every other flow, an
 * unknown kind, an extra field or a malformed value. It never throws, so a
 * creating transaction cannot fall back to a default.
 */
export function originForCreation(flow: unknown): BillingOrigin {
  try {
    if (!plainJson(flow)) return "shopify_install";
    const copy = clone<Record<string, unknown>>(flow);
    if (
      closed(copy, ["kind", "installHandoffPending"]) &&
      copy.kind === "website_signup" &&
      copy.installHandoffPending === false
    )
      return "website";
  } catch {
    // A hostile value (a throwing proxy) is a malformed flow.
  }
  return "shopify_install";
}

/** An installation's `workspace_store_links` row (migration 0005). */
export interface Association {
  readonly installationId: string;
  readonly storeId: string;
  readonly associatedAt: string;
  /** Installed and not disconnected; with `associatedAt <= now`, a current link. */
  readonly current: boolean;
}

export type ConflictCode =
  | "ROUTE_MISMATCH"
  | "DUPLICATE_SUBSCRIPTION"
  | "SUBSCRIPTION_TERMINAL"
  | "SUBSCRIPTION_REQUIRED";
const conflictCodes: readonly ConflictCode[] = [
  "ROUTE_MISMATCH",
  "DUPLICATE_SUBSCRIPTION",
  "SUBSCRIPTION_TERMINAL",
  "SUBSCRIPTION_REQUIRED",
];
/**
 * R7: a conflict is keyed by (workspace, payment route, subscriptionKey), or by
 * the payment key for a top-up, so every repeat invoice attaches to one record.
 */
export interface ConflictKey {
  readonly route: BillingRoute;
  readonly subscriptionKey: string | null;
  readonly paymentKey: string | null;
}
export interface OpenConflict extends ConflictKey {
  readonly code: ConflictCode;
}

export interface PayerFacts {
  /** null: associated, no account yet (Shopify). */
  readonly account: CurrentBilling_BillingAccount | null;
  /** The highest revision. */
  readonly entitlement: CurrentBilling_EntitlementSnapshot | null;
  /** null only on morrow_direct. */
  readonly association: Association | null;
  /** Reversals of payments granted to this payer; only `open` ones block it (R11). */
  readonly openReversals: readonly CurrentBilling_PaymentReversal[];
}

/** Parsed, frozen facts. Only `parseWorkspaceBillingFacts` issues them. */
export interface WorkspaceBillingFacts {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly environment: BillingEnvironment;
  /** null reads as origin `shopify_install` (R1). */
  readonly route: CurrentBilling_WorkspaceBillingRoute | null;
  /** Every installation ever associated, 0..100. */
  readonly associations: readonly Association[];
  /** No payer before a route is fixed; morrow_direct: exactly one, storeless; Shopify: one per associated installation that has one. */
  readonly payers: readonly PayerFacts[];
  readonly conflicts: readonly OpenConflict[];
  /** An unverified Morrow checkout intent exists (§8.7). */
  readonly checkoutIntentPending: boolean;
  /** A production parse never reads a seed: it is `withheld` and refused at evaluation. */
  readonly testSeed: CurrentBilling_TestEntitlementSeed | null | "withheld";
}

export type PayerStatus =
  | "billable"
  | "not_linked"
  | "account_missing"
  | "record_mismatch"
  | "mode_refused"
  | "subscription_inactive"
  | "payment_reversed"
  | "subscription_pending"
  | "entitlement_stale";

export interface PayerView {
  readonly billingAccountId: string | null;
  readonly route: BillingRoute | null;
  readonly installationId: string | null;
  readonly storeId: string | null;
  readonly status: PayerStatus;
  /** null for the storeless morrow_direct payer. */
  readonly linkCurrent: boolean | null;
  readonly subscriptionKey: string | null;
  /** `cancelled`, or `uninstalled` on Shopify, on the account or the entitlement. */
  readonly subscriptionTerminal: boolean;
  readonly entitlementRevision: number | null;
}

export interface AssociationView {
  readonly installationId: string;
  readonly storeId: string;
  readonly associatedAt: string;
  /** A current link at `evaluatedAt`: current and `associatedAt <= evaluatedAt`. */
  readonly current: boolean;
}

/** An accepted seed folded into the state: its stores intersected with current links. */
export type TestSeedState =
  | {
      readonly status: "accepted";
      readonly coveredStoreIds: readonly string[];
      readonly payer: TestSeedPayer;
    }
  | { readonly status: "inactive"; readonly reason: "SEED_NOT_YET_VALID" | "SEED_EXPIRED" }
  | { readonly status: "refused"; readonly reason: "SEED_REFUSED_IN_PRODUCTION" };

export interface WorkspaceBillingState {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly environment: BillingEnvironment;
  readonly evaluatedAt: string;
  readonly origin: BillingOrigin;
  readonly phase: BillingPhase;
  readonly route: BillingRoute | null;
  readonly mode: PaymentMode | null;
  readonly state: "no_route" | "not_billable" | "billable";
  readonly payers: readonly PayerView[];
  readonly associations: readonly AssociationView[];
  /** Route coverage: morrow_direct every current link; Shopify the stores whose own payer is billable. */
  readonly coveredStoreIds: readonly string[];
  readonly purchaseSurface: "morrow" | "shopify" | "none";
  readonly connectStoreOffered: boolean;
  readonly conflicts: readonly OpenConflict[];
  readonly testSeed: TestSeedState | null;
  /**
   * When the state stops being usable: the earliest `validUntil` of the accepted
   * seed and of every billable payer's entitlement, or null when nothing in it
   * entitles. `entitlementFor` and `selectPayers` refuse it before
   * `evaluatedAt` and from `expiresAt`, so a retained state cannot outlive the
   * seed or entitlement it was derived from.
   */
  readonly expiresAt: string | null;
}

const terminalStatuses: readonly string[] = ["cancelled", "uninstalled"];
const routeOf = (provider: "stripe" | "shopify"): BillingRoute =>
  provider === "stripe" ? "morrow_direct" : "shopify_app_pricing";

function parseAssociation(value: unknown): Association {
  if (
    !closed(value, ["installationId", "storeId", "associatedAt", "current"]) ||
    !id(value.installationId) ||
    !id(value.storeId) ||
    !utcTime(value.associatedAt) ||
    typeof value.current !== "boolean"
  )
    throw factsInvalid();
  return value as unknown as Association;
}
const sameAssociation = (a: Association, b: Association) =>
  a.installationId === b.installationId &&
  a.storeId === b.storeId &&
  a.associatedAt === b.associatedAt &&
  a.current === b.current;

// A plain record with exactly `keys` and data properties only. `opaque` is not
// descended into, so a production parse never reads a seed.
function plainRecord(
  value: unknown,
  keys: readonly string[],
  opaque: string | null,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw factsInvalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw factsInvalid();
  const own = Reflect.ownKeys(value);
  if (
    own.some((key) => typeof key !== "string") ||
    [...(own as string[])].sort().join(",") !== [...keys].sort().join(",")
  )
    throw factsInvalid();
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw factsInvalid();
    if (key !== opaque && !plainJson(descriptor.value)) throw factsInvalid();
    values[key] = descriptor.value;
  }
  return values;
}

function parseConflict(value: unknown): OpenConflict {
  if (
    !closed(value, ["route", "code", "subscriptionKey", "paymentKey"]) ||
    (value.route !== "morrow_direct" && value.route !== "shopify_app_pricing") ||
    !(conflictCodes as readonly unknown[]).includes(value.code) ||
    (value.subscriptionKey === null) === (value.paymentKey === null)
  )
    throw factsInvalid();
  const stripe = value.route === "morrow_direct";
  if (value.subscriptionKey !== null) {
    if (
      !validateCurrentBillingDefinition(
        stripe ? "StripeSubscriptionKey" : "ShopifySubscriptionKey",
        value.subscriptionKey,
      )
    )
      throw factsInvalid();
  } else if (!stripe || !validateCurrentBillingDefinition("StripePaymentKey", value.paymentKey))
    // Only a Stripe top-up is keyed by its payment.
    throw factsInvalid();
  return value as unknown as OpenConflict;
}

/**
 * Parses the trusted billing facts of one workspace (§6, §8.8). Throws
 * `BILLING_INPUT_INVALID` for a bad scope or environment and
 * `BILLING_FACTS_INVALID` for anything else: an unknown or missing field, a
 * schema-invalid record, a record of another tenant, more than 100
 * associations, payers or conflicts, a duplicate installation, account or
 * conflict key, an entitlement without its account, a payer before the route
 * is fixed, anything but one storeless payer on morrow_direct, an association
 * older than a morrow_direct route's `routeFixedAt` (R2, R3), or a storeless
 * payer on the Shopify route. Production never reads `testSeed`.
 */
export function parseWorkspaceBillingFacts(
  value: unknown,
  scope: BillingScope,
  environment: BillingEnvironment,
): WorkspaceBillingFacts {
  const env = parseEnvironment(environment);
  const { organizationId, workspaceId } = parseScope(scope);
  try {
    const raw = plainRecord(
      value,
      ["route", "associations", "payers", "conflicts", "checkoutIntentPending", "testSeed"],
      "testSeed",
    );
    const data = clone<Record<string, unknown>>({
      route: raw.route,
      associations: raw.associations,
      payers: raw.payers,
      conflicts: raw.conflicts,
      checkoutIntentPending: raw.checkoutIntentPending,
    });
    const route = data.route as CurrentBilling_WorkspaceBillingRoute | null;
    if (
      route !== null &&
      (!validateCurrentBillingDefinition("WorkspaceBillingRoute", route) ||
        route.organizationId !== organizationId ||
        route.workspaceId !== workspaceId)
    )
      throw factsInvalid();
    if (
      !Array.isArray(data.associations) ||
      data.associations.length > 100 ||
      !Array.isArray(data.payers) ||
      data.payers.length > 100 ||
      !Array.isArray(data.conflicts) ||
      data.conflicts.length > 100 ||
      typeof data.checkoutIntentPending !== "boolean"
    )
      throw factsInvalid();
    const associations = data.associations.map(parseAssociation);
    const currentStores = associations.filter((a) => a.current).map((a) => a.storeId);
    if (
      new Set(associations.map((a) => a.installationId)).size !== associations.length ||
      new Set(currentStores).size !== currentStores.length
    )
      throw factsInvalid();
    const payers = (data.payers as unknown[]).map((payer): PayerFacts => {
      if (!closed(payer, ["account", "entitlement", "association", "openReversals"]))
        throw factsInvalid();
      const { account, entitlement, association, openReversals } = payer;
      if (
        (account !== null && !validateCurrentBillingDefinition("BillingAccount", account)) ||
        (entitlement !== null &&
          (account === null ||
            !validateCurrentBillingDefinition("EntitlementSnapshot", entitlement))) ||
        !Array.isArray(openReversals) ||
        openReversals.length > 100 ||
        !openReversals.every((r) => validateCurrentBillingDefinition("PaymentReversal", r))
      )
        throw factsInvalid();
      let linked: Association | null = null;
      if (association !== null) {
        linked = parseAssociation(association);
        const known = associations.find((a) => a.installationId === linked!.installationId);
        if (!known || !sameAssociation(known, linked)) throw factsInvalid();
      }
      return {
        account: account as CurrentBilling_BillingAccount | null,
        entitlement: entitlement as CurrentBilling_EntitlementSnapshot | null,
        association: linked,
        openReversals: openReversals as CurrentBilling_PaymentReversal[],
      };
    });
    const fixed = route?.route ?? null;
    const accountIds = payers.flatMap((p) => (p.account ? [p.account.id] : []));
    const payerInstallations = payers.flatMap((p) =>
      p.association ? [p.association.installationId] : [],
    );
    if (
      // Accounts exist only once a route is fixed (§8.3).
      (fixed === null && payers.length > 0) ||
      (fixed === "morrow_direct" &&
        (payers.length !== 1 || payers[0]!.association !== null || payers[0]!.account === null)) ||
      // R2, R3: morrow_direct fixes only before any association, so no
      // association of a morrow_direct workspace predates its route.
      (fixed === "morrow_direct" &&
        associations.some(
          (a) => Date.parse(a.associatedAt) < Date.parse(route!.routeFixedAt as string),
        )) ||
      (fixed === "shopify_app_pricing" && payers.some((p) => p.association === null)) ||
      new Set(accountIds).size !== accountIds.length ||
      new Set(payerInstallations).size !== payerInstallations.length
    )
      throw factsInvalid();
    const conflicts = (data.conflicts as unknown[]).map(parseConflict);
    if (
      new Set(conflicts.map((c) => `${c.route}|${c.subscriptionKey ?? ""}|${c.paymentKey ?? ""}`))
        .size !== conflicts.length
    )
      throw factsInvalid();
    let testSeed: WorkspaceBillingFacts["testSeed"] = null;
    if (raw.testSeed !== null) {
      if (env === "production") testSeed = "withheld";
      else {
        if (!plainJson(raw.testSeed)) throw factsInvalid();
        testSeed = clone<CurrentBilling_TestEntitlementSeed>(raw.testSeed);
      }
    }
    const facts = freezeJson({
      organizationId,
      workspaceId,
      environment: env,
      route,
      associations,
      payers,
      conflicts,
      checkoutIntentPending: data.checkoutIntentPending,
      testSeed,
    }) as WorkspaceBillingFacts;
    issuedFacts.add(facts);
    return facts;
  } catch (error) {
    if (error instanceof BillingBoundaryError) throw error;
    throw factsInvalid();
  }
}

function payerStatus(
  payer: PayerFacts,
  route: CurrentBilling_WorkspaceBillingRoute,
  scope: BillingScope,
  mode: PaymentMode,
  at: number,
): PayerStatus {
  const link = payer.association;
  // (1) A Shopify payer's credits are spendable only while its link is current (R5).
  if (link !== null && (!link.current || Date.parse(link.associatedAt) > at)) return "not_linked";
  // (2)
  const account = payer.account;
  if (account === null) return "account_missing";
  const e = payer.entitlement;
  // (3) Tenant, route, installation or store disagree.
  if (
    account.organizationId !== scope.organizationId ||
    account.workspaceId !== scope.workspaceId ||
    account.route !== route.route ||
    account.installationId !== (link?.installationId ?? null) ||
    account.storeId !== (link?.storeId ?? null) ||
    (e !== null &&
      (e.billingAccountId !== account.id ||
        e.organizationId !== account.organizationId ||
        e.workspaceId !== account.workspaceId ||
        e.route !== account.route ||
        e.installationId !== account.installationId ||
        e.storeId !== account.storeId)) ||
    payer.openReversals.some(
      (r) =>
        r.route !== account.route ||
        r.mode !== account.mode ||
        (r.organizationId !== null &&
          (r.organizationId !== account.organizationId || r.workspaceId !== account.workspaceId)),
    )
  )
    return "record_mismatch";
  // (4) R9.
  if (route.mode !== mode || account.mode !== mode || (e !== null && e.mode !== mode))
    return "mode_refused";
  // (5) Terminal and inactive statuses before pending, so P14 reports truthfully.
  if (
    ["suspended", "cancelled", "uninstalled"].includes(account.status) ||
    (e !== null && ["past_due", "suspended", "cancelled", "uninstalled"].includes(e.status))
  )
    return "subscription_inactive";
  // (6) R11: a reversal blocks the payer even while the provider reports `active`.
  if (payer.openReversals.some((r) => r.status === "open")) return "payment_reversed";
  // (7)
  if (account.status === "pending" || e === null || e.status === "pending")
    return "subscription_pending";
  // (8)
  if (!(Date.parse(e.verifiedAt) <= at && at < Date.parse(e.validUntil)))
    return "entitlement_stale";
  return "billable";
}

/**
 * Derives the workspace's billing state at `now` (§3, §5). `environment` must be
 * the one the facts were parsed for. An accepted test seed folds in as
 * `testSeed`, with its stores intersected with current links; it never changes
 * the phase, the route state, the payers or the purchase surface.
 */
export function workspaceBillingState(
  facts: WorkspaceBillingFacts,
  now: string,
  environment: BillingEnvironment,
): WorkspaceBillingState {
  const env = parseEnvironment(environment);
  if (!issuedFacts.has(facts) || facts.environment !== env) throw inputInvalid();
  const evaluatedAt = parseTime(now);
  const at = Date.parse(evaluatedAt);
  const scope = { organizationId: facts.organizationId, workspaceId: facts.workspaceId };
  const route = facts.route;
  const origin: BillingOrigin = route?.origin ?? "shopify_install";
  const phase: BillingPhase =
    route?.route === "morrow_direct"
      ? "morrow_direct"
      : route?.route === "shopify_app_pricing"
        ? "shopify_app_pricing"
        : route !== null &&
            route.origin === "website" &&
            route.shopifyBoundAt === null &&
            facts.associations.length === 0
          ? "open"
          : "shopify_bound";
  const associations = facts.associations.map(
    (a): AssociationView => ({
      installationId: a.installationId,
      storeId: a.storeId,
      associatedAt: a.associatedAt,
      current: a.current && Date.parse(a.associatedAt) <= at,
    }),
  );
  const currentStores = associations.filter((a) => a.current).map((a) => a.storeId);
  const mode = environmentMode(env);
  const payers = facts.payers.map((p): PayerView => {
    const status = route ? payerStatus(p, route, scope, mode, at) : "record_mismatch";
    return {
      billingAccountId: p.account?.id ?? null,
      route: p.account?.route ?? null,
      installationId: p.association?.installationId ?? null,
      storeId: p.association?.storeId ?? null,
      status,
      linkCurrent:
        p.association === null
          ? null
          : p.association.current && Date.parse(p.association.associatedAt) <= at,
      subscriptionKey: p.entitlement?.subscriptionId ?? null,
      subscriptionTerminal:
        terminalStatuses.includes(p.account?.status ?? "") ||
        terminalStatuses.includes(p.entitlement?.status ?? ""),
      entitlementRevision: p.entitlement?.revision ?? null,
    };
  });
  const state =
    phase === "open" || phase === "shopify_bound"
      ? "no_route"
      : payers.some((p) => p.status === "billable")
        ? "billable"
        : "not_billable";
  const coveredStoreIds =
    phase === "morrow_direct"
      ? [...new Set(currentStores)].sort()
      : phase === "shopify_app_pricing"
        ? [
            ...new Set(
              payers.flatMap((p) => (p.status === "billable" && p.storeId ? [p.storeId] : [])),
            ),
          ].sort()
        : [];
  const purchaseSurface =
    phase === "open" || phase === "morrow_direct"
      ? "morrow"
      : currentStores.length > 0
        ? "shopify"
        : "none";
  let testSeed: TestSeedState | null = null;
  if (facts.testSeed !== null) {
    // Production refuses before reading; a withheld seed is never read.
    const evaluation = evaluateTestEntitlementSeed(
      facts.testSeed === "withheld" ? null : facts.testSeed,
      scope,
      evaluatedAt,
      env,
    );
    testSeed =
      evaluation.status === "accepted"
        ? {
            status: "accepted",
            coveredStoreIds: evaluation.coveredStoreIds.filter((s) => currentStores.includes(s)),
            payer: evaluation.payer,
          }
        : ({ status: evaluation.status, reason: evaluation.reason } as TestSeedState);
  }
  const limits = facts.payers.flatMap((p, i) =>
    payers[i]!.status === "billable" && p.entitlement ? [p.entitlement.validUntil] : [],
  );
  if (testSeed?.status === "accepted") limits.push(testSeed.payer.validUntil);
  const expiresAt =
    limits.length === 0
      ? null
      : limits.reduce((earliest, t) => (Date.parse(t) < Date.parse(earliest) ? t : earliest));
  const result = freezeJson({
    organizationId: facts.organizationId,
    workspaceId: facts.workspaceId,
    environment: env,
    evaluatedAt,
    origin,
    phase,
    route: route?.route ?? null,
    mode: route?.mode ?? null,
    state,
    payers,
    associations,
    coveredStoreIds,
    purchaseSurface,
    connectStoreOffered: !(phase === "open" && facts.checkoutIntentPending),
    conflicts: clone<OpenConflict[]>(facts.conflicts),
    testSeed: testSeed === null ? null : clone<TestSeedState>(testSeed),
    expiresAt,
  }) as WorkspaceBillingState;
  issuedStates.add(result);
  return result;
}

function issuedState(value: unknown): WorkspaceBillingState {
  if (value === null || typeof value !== "object" || !issuedStates.has(value)) throw inputInvalid();
  return value as WorkspaceBillingState;
}
// A state is usable from its `evaluatedAt` until its `expiresAt`.
const usableAt = (s: WorkspaceBillingState, at: number) =>
  at >= Date.parse(s.evaluatedAt) && (s.expiresAt === null || at < Date.parse(s.expiresAt));

/**
 * Whether paid work on `request` is entitled at `now`. False on a tenant
 * mismatch, a malformed request, a state this module did not issue, or a state
 * used before its `evaluatedAt` or from its `expiresAt` (so a retained state
 * stops entitling when its seed or entitlement expires). A storeless request
 * (including a connection-scoped `ad_account`) needs a billable workspace or
 * an accepted seed; a store-scoped request needs its store in
 * `coveredStoreIds` of a billable workspace, or in the accepted seed's linked
 * stores. Throws `BILLING_INPUT_INVALID` for a bad time.
 */
export function entitlementFor(
  state: WorkspaceBillingState,
  request: PermissionRequest,
  now: string,
): boolean {
  const at = Date.parse(parseTime(now));
  if (state === null || typeof state !== "object" || !issuedStates.has(state)) return false;
  if (!usableAt(state, at) || !plainJson(request)) return false;
  // Copy once, then read only the copy.
  const resource = clone<PermissionRequest | null>(request)?.resource;
  if (
    !resource ||
    resource.organizationId !== state.organizationId ||
    resource.workspaceId !== state.workspaceId
  )
    return false;
  const storeId = resource.storeId;
  if (storeId !== null && !id(storeId)) return false;
  const byRoute =
    state.state === "billable" && (storeId === null || state.coveredStoreIds.includes(storeId));
  const seed = state.testSeed;
  const bySeed =
    seed !== null &&
    seed.status === "accepted" &&
    (storeId === null || seed.coveredStoreIds.includes(storeId));
  return byRoute || bySeed;
}

// ---------------------------------------------------------------------------
// Denials (§9)
// ---------------------------------------------------------------------------

export type BillingDenialCode =
  | "BILLING_NO_ROUTE"
  | "BILLING_NOT_ACTIVE"
  | "STORE_NOT_BILLABLE"
  | "STORE_NOT_LINKED"
  | "ALLOCATION_REQUIRED"
  | "PAYER_SELECTION_REQUIRED"
  | "PAYER_NOT_BILLABLE"
  | "PAYER_OUTSIDE_WORK_SCOPE"
  | "DUPLICATE_PAYER_OR_STORE"
  | "ENTITLEMENT_NOT_CURRENT"
  | "PURCHASE_ROUTE_MISMATCH"
  | "SUBSCRIPTION_EXISTS"
  | "SUBSCRIPTION_REQUIRED"
  | "BILLING_FACTS_INVALID"
  | "BILLING_INPUT_INVALID";
export interface BillingDenialEnvelope {
  readonly code: "denied" | "missing_input" | "conflict" | "unavailable";
  readonly retryClass: "never" | "safe_read_retry" | "recheck_before_retry";
  readonly safeMessage: string;
}
const envelope = (
  code: BillingDenialEnvelope["code"],
  retryClass: BillingDenialEnvelope["retryClass"],
  safeMessage: string,
): BillingDenialEnvelope => Object.freeze({ code, retryClass, safeMessage });
const noRoute = envelope(
  "denied",
  "recheck_before_retry",
  "Paid work starts once this workspace has an active plan.",
);
const notActive = envelope(
  "denied",
  "recheck_before_retry",
  "A plan covering this work is not active.",
);
const chooseStore = envelope(
  "missing_input",
  "recheck_before_retry",
  "Choose which store pays for this work.",
);
// Every payer denial shares one envelope, so a denial never tells a foreign,
// unlinked, unauthorized, inactive or reversed payer apart.
const payerDenied = envelope(
  "denied",
  "recheck_before_retry",
  "This payer cannot pay for this work.",
);
const unavailable = envelope(
  "unavailable",
  "safe_read_retry",
  "Billing status is unavailable. Try again.",
);
/**
 * §9: one frozen ErrorEnvelope row per billing denial. No message names a
 * provider, price or checkout. Payment outcomes, held reasons, conflict codes
 * and `PAYMENT_MODE_REFUSED` are internal and never shown.
 */
export const BILLING_DENIAL_ENVELOPES: Readonly<Record<BillingDenialCode, BillingDenialEnvelope>> =
  Object.freeze({
    BILLING_NO_ROUTE: noRoute,
    BILLING_NOT_ACTIVE: notActive,
    STORE_NOT_BILLABLE: notActive,
    STORE_NOT_LINKED: envelope(
      "denied",
      "recheck_before_retry",
      "This store is not connected to this workspace.",
    ),
    ALLOCATION_REQUIRED: chooseStore,
    PAYER_SELECTION_REQUIRED: chooseStore,
    PAYER_NOT_BILLABLE: payerDenied,
    PAYER_OUTSIDE_WORK_SCOPE: payerDenied,
    DUPLICATE_PAYER_OR_STORE: payerDenied,
    ENTITLEMENT_NOT_CURRENT: envelope(
      "conflict",
      "recheck_before_retry",
      "Billing changed; review the work again.",
    ),
    PURCHASE_ROUTE_MISMATCH: envelope(
      "denied",
      "never",
      "Manage this workspace's plan where it was purchased.",
    ),
    SUBSCRIPTION_EXISTS: envelope(
      "conflict",
      "never",
      "This workspace already has a plan; change it instead.",
    ),
    SUBSCRIPTION_REQUIRED: envelope(
      "missing_input",
      "recheck_before_retry",
      "Choose a plan first.",
    ),
    BILLING_FACTS_INVALID: unavailable,
    BILLING_INPUT_INVALID: unavailable,
  });
export interface BillingDenial {
  readonly allowed: false;
  readonly code: BillingDenialCode;
  readonly envelope: BillingDenialEnvelope;
}
const deny = (code: BillingDenialCode): BillingDenial =>
  Object.freeze({ allowed: false, code, envelope: BILLING_DENIAL_ENVELOPES[code] });

// ---------------------------------------------------------------------------
// Purchase decisions and the call to action (§5)
// ---------------------------------------------------------------------------

export const morrowPurchaseActions = Object.freeze([
  "subscribe",
  "change_plan",
  "top_up",
  "update_payment_method",
  "cancel",
  "billing_portal",
  "view_invoices",
] as const);
export const shopifyPurchaseActions = Object.freeze([
  "shopify_plan_page",
  "shopify_usage_cap",
] as const);
export type MorrowPurchaseAction = (typeof morrowPurchaseActions)[number];
export type ShopifyPurchaseAction = (typeof shopifyPurchaseActions)[number];
export type PurchaseAction =
  | { readonly action: MorrowPurchaseAction }
  | { readonly action: ShopifyPurchaseAction; readonly storeId: string };
export type PurchaseDecision =
  | { readonly allowed: true; readonly action: MorrowPurchaseAction | ShopifyPurchaseAction }
  | BillingDenial;

function parsePurchaseAction(value: unknown): PurchaseAction {
  if (!plainJson(value)) throw inputInvalid();
  // Copy once, then check and return only the copy.
  const a = clone<Record<string, unknown>>(value);
  if (closed(a, ["action"]) && (morrowPurchaseActions as readonly unknown[]).includes(a.action))
    return { action: a.action as MorrowPurchaseAction };
  if (
    closed(a, ["action", "storeId"]) &&
    (shopifyPurchaseActions as readonly unknown[]).includes(a.action) &&
    id(a.storeId)
  )
    return { action: a.action as ShopifyPurchaseAction, storeId: a.storeId };
  throw inputInvalid();
}

/**
 * Decides one purchase action (§5 table). It decides only; P18.T01a mounts it
 * behind one guarded route prefix. A Shopify-bound or Shopify-route workspace
 * is refused every Morrow action.
 */
export function purchaseDecision(
  state: WorkspaceBillingState,
  action: PurchaseAction,
): PurchaseDecision {
  const s = issuedState(state);
  const a = parsePurchaseAction(action);
  const allow = (): PurchaseDecision => Object.freeze({ allowed: true, action: a.action });
  const isMorrow = !("storeId" in a);
  const linked = (storeId: string) =>
    s.associations.some((x) => x.storeId === storeId && x.current);
  switch (s.phase) {
    case "open":
      if (!isMorrow) return deny("PURCHASE_ROUTE_MISMATCH");
      return a.action === "subscribe" ? allow() : deny("SUBSCRIPTION_REQUIRED");
    case "shopify_bound":
    case "shopify_app_pricing": {
      if (isMorrow) return deny("PURCHASE_ROUTE_MISMATCH");
      const storeId = (a as { storeId: string }).storeId;
      if (a.action === "shopify_plan_page")
        return linked(storeId) ? allow() : deny("STORE_NOT_LINKED");
      if (s.phase === "shopify_bound") return deny("SUBSCRIPTION_REQUIRED");
      return s.payers.some((p) => p.storeId === storeId && p.status === "billable")
        ? allow()
        : deny("STORE_NOT_BILLABLE");
    }
    case "morrow_direct": {
      if (!isMorrow) return deny("PURCHASE_ROUTE_MISMATCH");
      if (a.action === "subscribe")
        // Only a resubscription after a terminal subscription.
        return s.payers.some((p) => p.subscriptionTerminal) ? allow() : deny("SUBSCRIPTION_EXISTS");
      if (a.action === "top_up")
        return s.state === "billable" ? allow() : deny("SUBSCRIPTION_REQUIRED");
      return allow();
    }
  }
}

export type BillingCallToAction =
  | { readonly kind: "morrow_plans"; readonly href: string; readonly label: string }
  | {
      readonly kind: "shopify_plan_page";
      readonly storeIds: readonly string[];
      readonly label: string;
    }
  | { readonly kind: "none" };
/** The route-neutral purchase wording every surface uses. */
export const BILLING_CALL_TO_ACTION_LABELS = Object.freeze({
  choose: "Choose a plan",
  manage: "Manage plan",
} as const);

/**
 * The only source of a purchase link or purchase wording on any Morrow surface
 * (§9 call-to-action rule). In a Shopify phase it never returns a Morrow
 * billing path, the word "checkout", a provider name, a price or a currency.
 */
export function billingCallToAction(state: WorkspaceBillingState): BillingCallToAction {
  const s = issuedState(state);
  const label =
    s.phase === "open" || s.phase === "shopify_bound"
      ? BILLING_CALL_TO_ACTION_LABELS.choose
      : BILLING_CALL_TO_ACTION_LABELS.manage;
  if (s.purchaseSurface === "morrow")
    return Object.freeze({
      kind: "morrow_plans",
      href: `/workspace/${encodeURIComponent(s.workspaceId)}/billing/morrow/plans`,
      label,
    });
  if (s.purchaseSurface === "shopify")
    return freezeJson({
      kind: "shopify_plan_page",
      storeIds: [...new Set(s.associations.filter((a) => a.current).map((a) => a.storeId))].sort(),
      label,
    }) as BillingCallToAction;
  return Object.freeze({ kind: "none" });
}

// ---------------------------------------------------------------------------
// Keys, terms and provider observations (§4.2, R9, R10)
// ---------------------------------------------------------------------------

const gidTail = (value: unknown, type: "App" | "Shop"): string => {
  const match =
    typeof value === "string"
      ? new RegExp(`^gid://shopify/${type}/(0|[1-9][0-9]{0,19})$`).exec(value)
      : null;
  if (!match) throw inputInvalid();
  return match[1]!;
};
const wholeSecond = (value: unknown): string => {
  const match =
    typeof value === "string"
      ? /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.0{1,9})?Z$/.exec(value)
      : null;
  // Only a time that is exactly a whole UTC second reduces without merging two
  // provider times into one key.
  if (!match || !Number.isFinite(Date.parse(match[1] + "Z"))) throw inputInvalid();
  const reduced = match[1] + "Z";
  if (new Date(reduced).toISOString() !== match[1] + ".000Z") throw inputInvalid();
  return reduced;
};

/**
 * The canonical Shopify key (P18.T01b uses it for every Shopify key): `cycle`
 * for a period (`currentBillingCycle.startTime`), `update` for a plan change
 * (`SUBSCRIPTION_UPDATED occurredAt`) and `created` for a subscription
 * (`SUBSCRIPTION_CREATED occurredAt`, recorded at first observation). GIDs are
 * parsed strictly and times must be whole UTC seconds; anything else throws
 * `BILLING_INPUT_INVALID`.
 */
export function canonicalShopifyKey(
  part: "cycle" | "update" | "created",
  appGid: string,
  shopGid: string,
  at: string,
): string {
  const definition =
    part === "cycle"
      ? "ShopifyPeriodKey"
      : part === "update"
        ? "ShopifyPlanChangeKey"
        : part === "created"
          ? "ShopifySubscriptionKey"
          : null;
  if (definition === null) throw inputInvalid();
  const key = `shopify:app:${gidTail(appGid, "App")}:shop:${gidTail(shopGid, "Shop")}:${part}:${wholeSecond(at)}`;
  if (!validateCurrentBillingDefinition(definition, key) || !id(key)) throw inputInvalid();
  return key;
}

/**
 * The §4.2 mapping of a Stripe invoice's `billing_reason` to an event kind.
 * Any other reason is held as `TERMS_MISMATCH`.
 */
export function stripePaymentKind(billingReason: unknown): PaymentKind | "TERMS_MISMATCH" {
  switch (billingReason) {
    case "subscription_create":
    case "subscription_cycle":
      return "subscription_period";
    case "subscription_update":
      return "plan_change";
    case "manual":
      return "top_up";
    default:
      return "TERMS_MISMATCH";
  }
}

const stripeStatuses: Readonly<Record<string, EntitlementStatus>> = Object.freeze({
  active: "active",
  trialing: "pending",
  incomplete: "pending",
  incomplete_expired: "cancelled",
  past_due: "past_due",
  unpaid: "suspended",
  paused: "suspended",
  canceled: "cancelled",
});
const shopifyObservationKeys = [
  "provider",
  "uninstalled",
  "subscriptionPresent",
  "canceled",
  "frozen",
  "inTrial",
  "currentBillingCycle",
  "effectivePriceZero",
  "cancelAtEndOfCycle",
];

/**
 * Maps a provider observation read back from the provider to the v1 entitlement
 * status (§4.2). Stripe: `{provider:"stripe", status, cancelAtPeriodEnd}`.
 * App Pricing: `{provider:"shopify_app_pricing", uninstalled, subscriptionPresent,
 * canceled, frozen, inTrial, currentBillingCycle, effectivePriceZero,
 * cancelAtEndOfCycle}`, where `canceled` is a `SUBSCRIPTION_CANCELED` event,
 * `frozen` a `SUBSCRIPTION_FROZEN` not followed by `SUBSCRIPTION_UNFROZEN`,
 * `currentBillingCycle` a non-null started cycle and `uninstalled` the
 * `app/uninstalled` webhook. A scheduled cancellation stays `active` (its
 * `validUntil` is bounded by the period end). Throws `BILLING_INPUT_INVALID`
 * on an unknown status or shape.
 */
export function mapProviderStatus(observation: unknown): EntitlementStatus {
  if (!plainJson(observation)) throw inputInvalid();
  // Copy once, then check and map only the copy.
  const o: unknown = clone(observation);
  if (closed(o, ["provider", "status", "cancelAtPeriodEnd"])) {
    if (
      o.provider !== "stripe" ||
      typeof o.status !== "string" ||
      !Object.hasOwn(stripeStatuses, o.status) ||
      typeof o.cancelAtPeriodEnd !== "boolean"
    )
      throw inputInvalid();
    return stripeStatuses[o.status]!;
  }
  if (
    !closed(o, shopifyObservationKeys) ||
    o.provider !== "shopify_app_pricing" ||
    shopifyObservationKeys.slice(1).some((k) => typeof o[k] !== "boolean")
  )
    throw inputInvalid();
  if (o.uninstalled) return "uninstalled";
  if (!o.subscriptionPresent || o.canceled) return "cancelled";
  if (o.frozen) return "suspended";
  if (o.inTrial || !o.currentBillingCycle) return "pending";
  if (o.effectivePriceZero) return "pending";
  return "active";
}
/** Whether a v1 entitlement status is billable (§4.2). */
export const billableStatus = (status: EntitlementStatus): boolean => status === "active";

export type BillingTerms = CurrentBilling_BillingTerms;
/**
 * Parses Morrow's versioned terms table (R10): schema-valid, and no
 * `(route, mode, priceKey)` or `(route, mode, fromPriceKey, toPriceKey)`
 * repeated, and no plan change to its own price. Throws `BILLING_INPUT_INVALID`.
 */
export function parseBillingTerms(value: unknown): BillingTerms {
  // Isolate first, then validate the copy that is used.
  if (!plainJson(value)) throw inputInvalid();
  const terms = clone<BillingTerms>(value);
  if (!validateCurrentBillingDefinition("BillingTerms", terms)) throw inputInvalid();
  const entryKeys = terms.entries.map((e) => `${e.route}|${e.mode}|${e.priceKey}`);
  const changeKeys = terms.planChanges.map(
    (c) => `${c.route}|${c.mode}|${c.fromPriceKey}|${c.toPriceKey}`,
  );
  if (
    new Set(entryKeys).size !== entryKeys.length ||
    new Set(changeKeys).size !== changeKeys.length ||
    terms.planChanges.some((c) => c.fromPriceKey === c.toPriceKey)
  )
    throw inputInvalid();
  return freezeJson(terms) as BillingTerms;
}

// ---------------------------------------------------------------------------
// Payment classification (§5 classifyPayment; R3, R7-R10)
// ---------------------------------------------------------------------------

export type HeldReason =
  | "INSTALLATION_NOT_ASSOCIATED"
  | "CUSTOMER_NOT_MAPPED"
  | "NOT_MORROW_INITIATED"
  | "TERMS_MISMATCH"
  | "SUBSCRIPTION_NOT_CURRENT";
export type UnattributedReason =
  | "INSTALLATION_NOT_ASSOCIATED"
  | "CUSTOMER_NOT_MAPPED"
  | "NOT_MORROW_INITIATED";
export type PaymentTarget =
  | { readonly kind: "workspace"; readonly state: WorkspaceBillingState }
  | {
      readonly kind: "unattributed";
      readonly reason: UnattributedReason;
      readonly environment: BillingEnvironment;
    };

/** A CreditGrant@2 without `id` and `billingAccountId`, which the writer assigns. */
export interface CreditGrantDraft {
  readonly schemaVersion: 2;
  readonly route: BillingRoute;
  readonly mode: PaymentMode;
  readonly paymentKey: string;
  readonly kind: "included" | "purchased";
  readonly creditUnits: string;
  readonly termsRevision: number;
  readonly purchaseEvidenceRef: string;
  readonly effectiveAt: string;
  readonly expiresAt: null;
}
/** The paying account: an existing one, or one the same transaction creates (§8.3). */
export type GrantAccount =
  | { readonly kind: "existing"; readonly billingAccountId: string }
  | {
      readonly kind: "create";
      readonly route: BillingRoute;
      readonly mode: PaymentMode;
      readonly installationId: string | null;
      readonly storeId: string | null;
      readonly currency: string;
    };
export type PaymentOutcome =
  | {
      readonly outcome: "refused";
      readonly code: "PAYMENT_MODE_REFUSED";
      readonly paymentKey: string;
    }
  | { readonly outcome: "already_granted"; readonly paymentKey: string }
  | { readonly outcome: "held"; readonly reason: HeldReason; readonly paymentKey: string }
  | { readonly outcome: "no_charge"; readonly paymentKey: string }
  | {
      readonly outcome: "conflict";
      readonly code: ConflictCode;
      readonly key: ConflictKey;
      readonly paymentKey: string;
    }
  | {
      readonly outcome: "grant";
      readonly paymentKey: string;
      readonly account: GrantAccount;
      readonly grant: CreditGrantDraft;
    }
  | {
      readonly outcome: "fix_route_and_grant";
      readonly paymentKey: string;
      readonly fixRoute: {
        readonly route: BillingRoute;
        readonly mode: PaymentMode;
        readonly fixingPaymentKey: string;
      };
      readonly account: GrantAccount;
      readonly grant: CreditGrantDraft;
    };

const unattributedReasons: readonly UnattributedReason[] = [
  "INSTALLATION_NOT_ASSOCIATED",
  "CUSTOMER_NOT_MAPPED",
  "NOT_MORROW_INITIATED",
];
function parseTarget(value: unknown): PaymentTarget {
  if (!plainJson(value)) throw inputInvalid();
  // Read each field once into a fresh record, then check only that record. The
  // state keeps its identity: only a state this module issued is accepted.
  const t: unknown = Object.fromEntries(Object.entries(value as object));
  if (closed(t, ["kind", "state"]) && t.kind === "workspace")
    return { kind: "workspace", state: issuedState(t.state) };
  if (
    closed(t, ["kind", "reason", "environment"]) &&
    t.kind === "unattributed" &&
    (unattributedReasons as readonly unknown[]).includes(t.reason)
  )
    return {
      kind: "unattributed",
      reason: t.reason as UnattributedReason,
      environment: parseEnvironment(t.environment),
    };
  throw inputInvalid();
}
const zeroAmount = (amount: string) => /^0(?:\.0+)?$/.test(amount);

/**
 * Classifies one verified payment into exactly one outcome (rules 1-9 of §5),
 * so no collected payment is silently dropped. `grantedKeys` holds the payment
 * keys already granted in the environment's mode (the key carries the route).
 * Throws `BILLING_INPUT_INVALID` for a malformed target, event, terms table or
 * key set, an event of another tenant, or a Shopify event whose installation
 * is not associated with the target workspace. The checked-in
 * `classify-payment.tsv` is the reviewers' specification of the same rules.
 */
export function classifyPayment(
  target: PaymentTarget,
  event: unknown,
  terms: unknown,
  grantedKeys: ReadonlySet<string>,
): PaymentOutcome {
  const t = parseTarget(target);
  if (!plainJson(event)) throw inputInvalid();
  const e = clone<CurrentBilling_VerifiedPaymentEvent>(event);
  if (!validateCurrentBillingDefinition("VerifiedPaymentEvent", e)) throw inputInvalid();
  const table = parseBillingTerms(terms);
  if (!(grantedKeys instanceof Set) || Object.getPrototypeOf(grantedKeys) !== Set.prototype)
    throw inputInvalid();
  const environment = t.kind === "workspace" ? t.state.environment : t.environment;
  const stripe = e.route === "morrow_direct";
  // An unattributed reason belongs to one provider: a Stripe customer or object,
  // or an App Pricing installation.
  if (t.kind === "unattributed" && (t.reason === "INSTALLATION_NOT_ASSOCIATED") === stripe)
    throw inputInvalid();
  const s = t.kind === "workspace" ? t.state : null;
  let association: AssociationView | undefined;
  if (s !== null) {
    if (e.organizationId !== s.organizationId || e.workspaceId !== s.workspaceId)
      throw inputInvalid();
    if (!stripe) {
      association = s.associations.find((a) => a.installationId === e.installationId);
      // An attributed App Pricing event names an installation associated with the workspace.
      if (!association || association.storeId !== e.storeId) throw inputInvalid();
    }
  }
  const paymentKey = e.paymentKey;
  const done = (outcome: PaymentOutcome): PaymentOutcome => freezeJson(outcome) as PaymentOutcome;
  // 1. R9.
  if (e.mode !== environmentMode(environment))
    return done({ outcome: "refused", code: "PAYMENT_MODE_REFUSED", paymentKey });
  // 2. Replay: nothing changes. The Set's own `has`, never a shadowing property.
  if (Set.prototype.has.call(grantedKeys, paymentKey))
    return done({ outcome: "already_granted", paymentKey });
  // 3. R8: unattributed, or a Stripe object that traces to no Morrow operation.
  if (t.kind === "unattributed") return done({ outcome: "held", reason: t.reason, paymentKey });
  if (stripe && e.operationId === null)
    return done({ outcome: "held", reason: "NOT_MORROW_INITIATED", paymentKey });
  const state = s!;
  // 4. R3: money actually collected.
  if (zeroAmount(e.amountPaid.amount)) return done({ outcome: "no_charge", paymentKey });
  const conflict = (code: ConflictCode): PaymentOutcome =>
    done({
      outcome: "conflict",
      code,
      key: {
        route: e.route,
        subscriptionKey: e.subscriptionKey,
        paymentKey: e.subscriptionKey === null ? paymentKey : null,
      },
      paymentKey,
    });
  // 5. R7: a second charge path.
  if (
    (stripe && (state.phase === "shopify_bound" || state.phase === "shopify_app_pricing")) ||
    (!stripe && state.phase === "morrow_direct")
  )
    return conflict("ROUTE_MISMATCH");
  // 6. R10: credits come only from Morrow's terms table.
  const currency = e.amountPaid.currency;
  const entry = (priceKey: string, kind: "subscription_period" | "top_up") =>
    table.entries.find(
      (x) =>
        x.route === e.route &&
        x.mode === e.mode &&
        x.priceKey === priceKey &&
        x.kind === kind &&
        x.currency === currency,
    );
  let creditUnits: string;
  if (e.kind === "plan_change") {
    const change = table.planChanges.find(
      (x) =>
        x.route === e.route &&
        x.mode === e.mode &&
        x.fromPriceKey === e.fromPriceKey &&
        x.toPriceKey === e.priceKey,
    );
    if (!change || !entry(e.priceKey, "subscription_period"))
      return done({ outcome: "held", reason: "TERMS_MISMATCH", paymentKey });
    creditUnits = change.creditUnits;
  } else {
    const found = entry(e.priceKey, e.kind);
    if (!found) return done({ outcome: "held", reason: "TERMS_MISMATCH", paymentKey });
    creditUnits = found.creditUnits;
  }
  // The event's payer: the storeless account for Stripe, the installation's account for App Pricing.
  const payer = stripe
    ? state.payers.find((p) => p.installationId === null && p.billingAccountId !== null)
    : state.payers.find(
        (p) => p.installationId === e.installationId && p.billingAccountId !== null,
      );
  const relation = ():
    | "none"
    | "current"
    | "other_live"
    | "new_after_terminal"
    | "current_terminal" => {
    if (!payer || payer.subscriptionKey === null) return "none";
    if (e.subscriptionKey === null || e.subscriptionKey === payer.subscriptionKey)
      return payer.subscriptionTerminal ? "current_terminal" : "current";
    return payer.subscriptionTerminal ? "new_after_terminal" : "other_live";
  };
  const grant = (kind: "included" | "purchased"): CreditGrantDraft => ({
    schemaVersion: 2,
    route: e.route,
    mode: e.mode,
    paymentKey,
    kind,
    creditUnits,
    termsRevision: table.termsRevision,
    purchaseEvidenceRef: e.providerEvidenceRef,
    effectiveAt: e.verifiedAt,
    expiresAt: null,
  });
  const existing = (): GrantAccount => ({
    kind: "existing",
    billingAccountId: payer!.billingAccountId!,
  });
  const create = (): GrantAccount => ({
    kind: "create",
    route: e.route,
    mode: e.mode,
    installationId: e.installationId,
    storeId: e.storeId,
    currency,
  });
  // 7. Top-ups (Stripe only): only for a billable morrow_direct payer.
  if (e.kind === "top_up")
    return state.phase === "morrow_direct" && payer?.status === "billable"
      ? done({ outcome: "grant", paymentKey, account: existing(), grant: grant("purchased") })
      : conflict("SUBSCRIPTION_REQUIRED");
  const rel = relation();
  // 8. Plan changes: never a duplicate subscription, a second period grant or a silent replay.
  if (e.kind === "plan_change") {
    if (rel === "current")
      return done({ outcome: "grant", paymentKey, account: existing(), grant: grant("included") });
    if (rel === "other_live") return conflict("DUPLICATE_SUBSCRIPTION");
    if (rel === "current_terminal") return conflict("SUBSCRIPTION_TERMINAL");
    return done({ outcome: "held", reason: "SUBSCRIPTION_NOT_CURRENT", paymentKey });
  }
  // 9. Subscription periods.
  if (state.phase === "open" || state.phase === "shopify_bound")
    return done({
      outcome: "fix_route_and_grant",
      paymentKey,
      fixRoute: { route: e.route, mode: e.mode, fixingPaymentKey: paymentKey },
      account: create(),
      grant: grant("included"),
    });
  // An installation's first period creates its account, current link or not (R5).
  if (!payer)
    return done({ outcome: "grant", paymentKey, account: create(), grant: grant("included") });
  if (rel === "current")
    return done({ outcome: "grant", paymentKey, account: existing(), grant: grant("included") });
  if (rel === "other_live") return conflict("DUPLICATE_SUBSCRIPTION");
  if (rel === "current_terminal") return conflict("SUBSCRIPTION_TERMINAL");
  // A payer whose subscription is not recorded yet, or a new subscription after
  // a terminal one: held until the entitlement fold records it (R7, R8). Folding
  // records one subscription; the held periods are then re-classified, so the
  // recorded one is granted and any other is DUPLICATE_SUBSCRIPTION. Granting
  // each new subscription here would let two resubscriptions both be granted.
  return done({ outcome: "held", reason: "SUBSCRIPTION_NOT_CURRENT", paymentKey });
}

// ---------------------------------------------------------------------------
// Entitlement folding (§5 foldEntitlementEvidence)
// ---------------------------------------------------------------------------

/** A fresh provider read: an EntitlementSnapshot@2 without revision and verifiedAt, plus when it was observed. */
export interface EntitlementObservation {
  readonly billingAccountId: string;
  readonly route: BillingRoute;
  readonly mode: PaymentMode;
  readonly installationId: string | null;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string | null;
  readonly subscriptionId: string;
  readonly status: EntitlementStatus;
  readonly providerEvidenceRef: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export type EntitlementFold =
  | { readonly result: "next"; readonly snapshot: CurrentBilling_EntitlementSnapshot }
  | { readonly result: "unchanged" }
  | { readonly result: "stale_observation" }
  | { readonly result: "identity_changed" }
  | { readonly result: "terminal_revival_refused" };
const observationKeys = [
  "billingAccountId",
  "route",
  "mode",
  "installationId",
  "organizationId",
  "workspaceId",
  "storeId",
  "subscriptionId",
  "status",
  "providerEvidenceRef",
  "observedAt",
  "validUntil",
];
/** Restriction rank: uninstalled, cancelled > suspended > past_due > pending > active. */
const restriction: Readonly<Record<EntitlementStatus, number>> = Object.freeze({
  active: 0,
  pending: 1,
  past_due: 2,
  suspended: 3,
  cancelled: 4,
  uninstalled: 4,
});

/**
 * Folds one provider observation into the current snapshot. A webhook or
 * redirect only triggers the read; an unknown read outcome produces no
 * observation (the caller re-reads). A terminal status is absorbing for its
 * subscription: a terminal snapshot refuses a live observation of the same
 * subscription, and a terminal observation replaces a live snapshot of it
 * whatever its `observedAt`. Otherwise observations order by `observedAt`, then
 * restriction rank, then evidence reference, so ties resolve to the more
 * restrictive status in any arrival order, and any permutation of one
 * subscription's observations ends with the same status, evidence and
 * `verifiedAt`. Throws `BILLING_INPUT_INVALID`.
 */
export function foldEntitlementEvidence(
  currentSnapshot: CurrentBilling_EntitlementSnapshot | null,
  observed: unknown,
): EntitlementFold {
  if (currentSnapshot !== null && !plainJson(currentSnapshot)) throw inputInvalid();
  const current =
    currentSnapshot === null ? null : clone<CurrentBilling_EntitlementSnapshot>(currentSnapshot);
  if (current !== null && !validateCurrentBillingDefinition("EntitlementSnapshot", current))
    throw inputInvalid();
  if (!plainJson(observed)) throw inputInvalid();
  const o = clone<EntitlementObservation>(observed);
  if (!closed(o, observationKeys) || !utcTime(o.observedAt)) throw inputInvalid();
  const { observedAt, ...fields } = o;
  const snapshot = {
    schemaVersion: 2,
    ...fields,
    verifiedAt: observedAt,
    revision: current === null ? 1 : current.revision + 1,
  };
  if (!validateCurrentBillingDefinition("EntitlementSnapshot", snapshot)) throw inputInvalid();
  const next = (): EntitlementFold => freezeJson({ result: "next", snapshot }) as EntitlementFold;
  if (current === null) return next();
  if (current.providerEvidenceRef === o.providerEvidenceRef)
    return Object.freeze({ result: "unchanged" });
  const terminal = terminalStatuses.includes(current.status);
  const sameHolder =
    current.billingAccountId === o.billingAccountId &&
    current.route === o.route &&
    current.mode === o.mode &&
    current.installationId === o.installationId &&
    current.storeId === o.storeId &&
    current.organizationId === o.organizationId &&
    current.workspaceId === o.workspaceId;
  // Only a new subscription after a terminal one may replace the identity.
  if (!sameHolder || (current.subscriptionId !== o.subscriptionId && !terminal))
    return Object.freeze({ result: "identity_changed" });
  const sameSubscription = current.subscriptionId === o.subscriptionId;
  const observedTerminal = terminalStatuses.includes(o.status);
  if (sameSubscription && terminal && !observedTerminal)
    return Object.freeze({ result: "terminal_revival_refused" });
  // A terminal observation is absorbing for its subscription, whatever its
  // `observedAt`: an older cancellation processed after a newer live read still
  // ends the subscription, so every arrival order converges on the terminal one.
  if (sameSubscription && !terminal && observedTerminal) return next();
  const a = Date.parse(o.observedAt),
    b = Date.parse(current.verifiedAt);
  const newer =
    a !== b
      ? a > b
      : restriction[o.status] !== restriction[current.status]
        ? restriction[o.status] > restriction[current.status]
        : o.providerEvidenceRef > current.providerEvidenceRef;
  return newer ? next() : Object.freeze({ result: "stale_observation" });
}

// ---------------------------------------------------------------------------
// Spending scope and payer selection (§5)
// ---------------------------------------------------------------------------

export interface SpendingScope {
  readonly workspace: boolean;
  readonly storeIds: readonly string[];
}
const permissionVerbs: readonly string[] = [
  "view",
  "propose",
  "approve",
  "execute",
  "delegate",
  "administer",
];

/**
 * Recorded interpretation (it only narrows): over the grants that are current
 * for the request's capability and verb in the actor's tenant, `workspace` is
 * true when any exists and `storeIds` are the stores their scopes list. Empty
 * when the request is not paid work or not in the actor's tenant. An actor may
 * charge only for work they could run; P11.T04a's capped mandates may only
 * narrow it. Throws `BILLING_INPUT_INVALID`.
 */
export function spendingScope(
  grantList: readonly Core_Grant[],
  actorRef: Core_ActorRef,
  permissionRequest: PermissionRequest,
  policyRevision: number,
  now: string,
): SpendingScope {
  if (!plainJson(grantList) || !plainJson(actorRef) || !plainJson(permissionRequest))
    throw inputInvalid();
  // Isolate first, then validate the copies that are used.
  const grants = clone<Core_Grant[]>(grantList);
  const actor = clone<Core_ActorRef>(actorRef);
  const request = clone<PermissionRequest>(permissionRequest);
  if (
    !Array.isArray(grants) ||
    grants.length > 1000 ||
    !grants.every((g) => validateDefinition("core", "Grant", g)) ||
    !validateDefinition("core", "ActorRef", actor) ||
    !closed(request, ["capabilityId", "verb", "resource", "accountId", "fields"]) ||
    !validateDefinition("core", "CapabilityId", request.capabilityId) ||
    !permissionVerbs.includes(request.verb as string) ||
    !validateDefinition("core", "ResourceRef", request.resource) ||
    !validateDefinition("core", "Revision", policyRevision)
  )
    throw inputInvalid();
  const at = Date.parse(parseTime(now));
  const empty = Object.freeze({
    workspace: false,
    storeIds: Object.freeze([]) as readonly string[],
  });
  if (!isPaidWork(request.capabilityId, request.verb)) return empty;
  if (
    actor.workspaceId === null ||
    request.resource.organizationId !== actor.organizationId ||
    request.resource.workspaceId !== actor.workspaceId
  )
    return empty;
  const eligible = grants.filter(
    (g) =>
      isCurrentGrant(g, actor, request.capabilityId, request.verb, policyRevision, at) &&
      g.scope.organizationId === actor.organizationId &&
      g.scope.workspaceId === actor.workspaceId,
  );
  return freezeJson({
    workspace: eligible.length > 0,
    storeIds: [...new Set(eligible.flatMap((g) => g.scope.storeIds))].sort(),
  }) as SpendingScope;
}

export interface PayerSelectionInput {
  readonly organizationId: string;
  readonly workspaceId: string;
  /** 0..100 unique stores from the task's or Proposal@2's bound resources. */
  readonly workStoreIds: readonly string[];
  readonly spending: SpendingScope;
  /** null only before review or admission. */
  readonly allocation: CurrentBilling_CostAllocation | null;
}
export interface PayerShare {
  readonly billingAccountId: string;
  readonly installationId: string | null;
  readonly storeId: string | null;
  readonly entitlementRevision: number;
}
export type PayerSelection =
  | {
      readonly ok: true;
      readonly selection: "implicit" | "explicit";
      readonly shares: readonly PayerShare[];
    }
  | {
      readonly ok: false;
      readonly code: BillingDenialCode;
      readonly envelope: BillingDenialEnvelope;
    };
const uniqueIds = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every(id) &&
  new Set(value).size === value.length;

/**
 * Selects who pays for paid work (§5, ADR-0015 item 6): the one workspace
 * account on morrow_direct; per-shop accounts with explicit allocations on the
 * Shopify route. Each rule runs across every store or share before the next.
 * `implicit` only feeds a one-share allocation that review binds; reservation
 * and dispatch always pass the bound allocation. A state used before its
 * `evaluatedAt` or from its `expiresAt` gives `ENTITLEMENT_NOT_CURRENT`. It
 * reads no wallet and reserves nothing. Throws `BILLING_INPUT_INVALID` for
 * malformed input or a bad time.
 */
export function selectPayers(
  state: WorkspaceBillingState,
  selectionInput: PayerSelectionInput,
  now: string,
): PayerSelection {
  const s = issuedState(state);
  const at = Date.parse(parseTime(now));
  if (!plainJson(selectionInput)) throw inputInvalid();
  // Isolate first, then validate the copy that is used.
  const input = clone<PayerSelectionInput>(selectionInput);
  if (
    !closed(input, ["organizationId", "workspaceId", "workStoreIds", "spending", "allocation"]) ||
    !id(input.organizationId) ||
    !id(input.workspaceId) ||
    !uniqueIds(input.workStoreIds, 100) ||
    !closed(input.spending, ["workspace", "storeIds"]) ||
    typeof input.spending.workspace !== "boolean" ||
    !uniqueIds(input.spending.storeIds, 100) ||
    (input.allocation !== null &&
      !validateCurrentBillingDefinition("CostAllocation", input.allocation))
  )
    throw inputInvalid();
  const fail = (code: BillingDenialCode): PayerSelection =>
    Object.freeze({ ok: false, code, envelope: BILLING_DENIAL_ENVELOPES[code] });
  const succeed = (selection: "implicit" | "explicit", shares: PayerShare[]): PayerSelection =>
    freezeJson({ ok: true, selection, shares }) as PayerSelection;
  const allocation = input.allocation;
  const work = [...input.workStoreIds];
  // 0.
  if (
    input.organizationId !== s.organizationId ||
    input.workspaceId !== s.workspaceId ||
    (allocation !== null &&
      (allocation.organizationId !== s.organizationId || allocation.workspaceId !== s.workspaceId))
  )
    return fail("PAYER_NOT_BILLABLE");
  // 0b. A retained state outside its window is re-evaluated, never trusted.
  if (!usableAt(s, at)) return fail("ENTITLEMENT_NOT_CURRENT");
  // 1.
  if (s.state === "no_route") return fail("BILLING_NO_ROUTE");
  if (s.state === "not_billable") return fail("BILLING_NOT_ACTIVE");
  // 2.
  const linked = new Set(s.associations.filter((a) => a.current).map((a) => a.storeId));
  if (work.some((storeId) => !linked.has(storeId))) return fail("STORE_NOT_LINKED");
  const shopify = s.phase === "shopify_app_pricing";
  const billableStore = (storeId: string) =>
    s.payers.some((p) => p.storeId === storeId && p.status === "billable");
  if (shopify && work.some((storeId) => !billableStore(storeId))) return fail("STORE_NOT_BILLABLE");
  // 3. Candidates: other payers are invisible from here on.
  const candidates = s.payers.filter((p) =>
    shopify
      ? p.status === "billable" && p.storeId !== null && input.spending.storeIds.includes(p.storeId)
      : p.status === "billable" && p.installationId === null && input.spending.workspace,
  );
  const shareOf = (p: PayerView): PayerShare => ({
    billingAccountId: p.billingAccountId!,
    installationId: p.installationId,
    storeId: p.storeId,
    entitlementRevision: p.entitlementRevision!,
  });
  // 4. No allocation.
  if (allocation === null) {
    if (!shopify)
      return candidates.length === 1
        ? succeed("implicit", [shareOf(candidates[0]!)])
        : fail("PAYER_NOT_BILLABLE");
    if (work.length >= 2) return fail("ALLOCATION_REQUIRED");
    if (work.length === 1) {
      const own = candidates.find((p) => p.storeId === work[0]);
      return own ? succeed("implicit", [shareOf(own)]) : fail("PAYER_NOT_BILLABLE");
    }
    if (candidates.length === 0) return fail("PAYER_NOT_BILLABLE");
    return candidates.length === 1
      ? succeed("implicit", [shareOf(candidates[0]!)])
      : fail("PAYER_SELECTION_REQUIRED");
  }
  // 5. Allocation.
  const shares = allocation.shares;
  const storeShares = shares.flatMap((x) => (x.storeId === null ? [] : [x.storeId]));
  if (
    new Set(shares.map((x) => x.billingAccountId)).size !== shares.length ||
    new Set(storeShares).size !== storeShares.length
  )
    return fail("DUPLICATE_PAYER_OR_STORE");
  const matched = shares.map((x) =>
    candidates.find(
      (p) =>
        p.billingAccountId === x.billingAccountId &&
        p.installationId === x.installationId &&
        p.storeId === x.storeId,
    ),
  );
  if (matched.some((p) => p === undefined)) return fail("PAYER_NOT_BILLABLE");
  if (
    shopify &&
    work.length > 0 &&
    shares.some((x) => x.storeId === null || !work.includes(x.storeId))
  )
    return fail("PAYER_OUTSIDE_WORK_SCOPE");
  if (shares.some((x, i) => x.entitlementRevision !== matched[i]!.entitlementRevision))
    return fail("ENTITLEMENT_NOT_CURRENT");
  return succeed(
    "explicit",
    matched.map((p) => shareOf(p!)),
  );
}

// ---------------------------------------------------------------------------
// Composition: the constraints reader (§6)
// ---------------------------------------------------------------------------

/** Reads the trusted billing facts of the SQL-resolved actor's workspace (provisional; P18.T01a re-cuts it). */
export type BillingFactsReader = (scope: BillingScope) => Promise<unknown>;

/**
 * Composes the provider constraints reader with the billing facts reader.
 * Non-paid requests never call the billing reader and get the inert
 * `entitlementAllowed: false`, so a billing outage never blocks reads, setup,
 * linking, invitations, approvals, exports or stops. Paid requests read the
 * actor's workspace facts, evaluate them at `clock()` and return
 * `entitlementFor`. Any reader, parse or clock failure throws without retry
 * (`IDENTITY_UNAVAILABLE` at the boundary, `POLICY_AUTHORITY_UNAVAILABLE`
 * through `createHumanPolicyService`).
 */
export function createBillingConstraintsReader(
  provider: CurrentConstraintsReader,
  billing: BillingFactsReader,
  environment: BillingEnvironment,
  clock: () => Date = () => new Date(),
): CurrentConstraintsReader {
  const env = parseEnvironment(environment);
  return Object.freeze({
    async readCurrent(permissionRequest: PermissionRequest, actorRef: Core_ActorRef) {
      // Copy the request and actor once; everything below reads only the copies.
      if (!plainJson(permissionRequest) || !plainJson(actorRef)) throw inputInvalid();
      const request = clone<PermissionRequest>(permissionRequest);
      const actor = clone<Core_ActorRef>(actorRef);
      const result: unknown = await provider.readCurrent(request, actor);
      if (!plainJson(result)) throw factsInvalid();
      // Read the provider pair once, as a copy, before checking it.
      const base = clone<Record<string, unknown>>(result);
      if (
        !closed(base, ["providerAllowed", "entitlementAllowed"]) ||
        typeof base.providerAllowed !== "boolean" ||
        typeof base.entitlementAllowed !== "boolean"
      )
        throw factsInvalid();
      const providerAllowed = base.providerAllowed;
      if (!isPaidWork(request.capabilityId, request.verb))
        return { providerAllowed, entitlementAllowed: false };
      if (actor.workspaceId === null) throw inputInvalid();
      const scope = { organizationId: actor.organizationId, workspaceId: actor.workspaceId };
      const raw = await billing(scope);
      const facts = parseWorkspaceBillingFacts(raw, scope, env);
      const at = clock().toISOString();
      const state = workspaceBillingState(facts, at, env);
      return { providerAllowed, entitlementAllowed: entitlementFor(state, request, at) };
    },
  });
}
