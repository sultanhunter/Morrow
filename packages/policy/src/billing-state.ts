// Billing state library (P01.T04a §5; ADR-0015). Pure: no I/O, clock or
// randomness. The environment comes from the composition root and `now` from
// the caller's clock; facts come only from a trusted server reader, never from
// an HTTP body, checkout return, redirect parameter, plan handle, provider
// metadata, browser login or model output.
//
// PR-A holds the §4.4 test entitlement seed branch (ADR-0015 follow-up decision
// OQ-2 (a)). PR-B adds the route library (origin, phase, entitlement, purchase
// decisions, payment classification, payers) and `createBillingConstraintsReader`,
// which folds an accepted seed into the workspace state.
import type { CurrentBilling_TestEntitlementSeed } from "@morrow/contracts";
import { validateCurrentBillingDefinition, validateDefinition } from "@morrow/contracts/validation";
import { plainJson, closed, freezeJson } from "./json-boundary";
import type { PermissionRequest } from "./index";

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

// Only evaluations this module returned can entitle; a hand-built object cannot.
const issued = new WeakSet<object>();
const id = (value: unknown) => validateDefinition("core", "Id", value);
const utcTime = (value: unknown): value is string =>
  validateDefinition("core", "UtcTime", value) && Number.isFinite(Date.parse(value as string));

function parseEnvironment(value: unknown): BillingEnvironment {
  if (typeof value !== "string" || !(billingEnvironments as readonly string[]).includes(value))
    throw new BillingBoundaryError("BILLING_INPUT_INVALID");
  return value as BillingEnvironment;
}
function parseScope(value: unknown): BillingScope {
  if (
    !plainJson(value) ||
    !closed(value, ["organizationId", "workspaceId"]) ||
    !id(value.organizationId) ||
    !id(value.workspaceId)
  )
    throw new BillingBoundaryError("BILLING_INPUT_INVALID");
  return {
    organizationId: value.organizationId as string,
    workspaceId: value.workspaceId as string,
  };
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
  if (!utcTime(now)) throw new BillingBoundaryError("BILLING_INPUT_INVALID");
  if (!plainJson(seed) || !validateCurrentBillingDefinition("TestEntitlementSeed", seed))
    throw new BillingBoundaryError("BILLING_FACTS_INVALID");
  // Isolate the caller's object before reading it.
  const record = JSON.parse(JSON.stringify(seed)) as CurrentBilling_TestEntitlementSeed;
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
    throw new BillingBoundaryError("BILLING_FACTS_INVALID");
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
  if (!utcTime(now)) throw new BillingBoundaryError("BILLING_INPUT_INVALID");
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
