import {
  encodeStripeCheckoutResult,
  encodeStripeCustomerResult,
  encodeStripePortalResult,
  encodeStripeWebhookResult,
  stripeBudgetValid,
  stripeLimits,
  stripeOperationIdValid,
} from "../../../packages/identity/src/broker-protocol.js";
import {
  BrokerHold,
  brokerCapabilities,
  invokeBrokerMethod,
  type BrokerVault,
} from "./capabilities.js";
import {
  StripeHold,
  stripeCheckoutCreate,
  stripeCustomerEnsure,
  stripePortalCreate,
  stripeWebhookVerify,
  type StripeDependencies,
} from "./stripe.js";
import { runVaultTransaction } from "./vault-database.js";
import type { VaultQuery } from "./vault.js";

// The ApiBroker's Stripe methods (M5 PR-1): handlers that check the closed inputs, build the
// Stripe dependencies from the broker's own capabilities (the restricted key and webhook
// secret never leave the broker) and return the closed result JSON. Every failure is
// BROKER_HELD with one fixed log line (invokeBrokerMethod). While the Stripe switch is off
// (owner decision (c), 2026-10-21; no MORROW_STRIPE_MODE), every method is refused first
// with the fixed code STRIPE_UNAVAILABLE: no input is parsed and no vault transaction,
// database row or Stripe request is made.
//
// createStripeBroker takes the three seams the handlers use, as M2 PR-2's
// createShopifyBroker does: the deployed broker passes the vault login's real transport
// (runVaultTransaction), the platform fetch and the clock; lab:billing-workers passes the
// same transport over its PostgreSQL bridge (runVaultTransactionWithDriver).
export interface StripeBrokerSeams {
  readonly transaction: <T>(
    vault: Readonly<BrokerVault>,
    budgetMs: number,
    body: (query: VaultQuery) => Promise<T>,
  ) => Promise<T>;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly now: () => number;
}

async function held<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StripeHold)
      throw new BrokerHold(
        error.code === "PROVIDER_HELD"
          ? "PROVIDER_HELD"
          : error.code === "INPUT_INVALID"
            ? "INPUT_INVALID"
            : "STATE_INVALID",
      );
    throw error;
  }
}
const writeInputs = (operationId: unknown, budgetMs: unknown) => {
  if (!stripeOperationIdValid(operationId)) throw new BrokerHold("INPUT_INVALID");
  if (!stripeBudgetValid(budgetMs)) throw new BrokerHold("BUDGET_INVALID");
};

export function createStripeBroker(seams: Readonly<StripeBrokerSeams>) {
  async function switchedOn(env: unknown): Promise<void> {
    if ((await brokerCapabilities(env)).stripeMode !== "test")
      throw new BrokerHold("STRIPE_UNAVAILABLE");
  }
  async function dependencies(env: unknown): Promise<StripeDependencies> {
    const capabilities = await brokerCapabilities(env);
    const vault = capabilities.vault;
    const stripe = capabilities.stripe;
    if (!vault || !stripe) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
    return Object.freeze({
      stripe,
      fetch: seams.fetch,
      transaction: <T>(budgetMs: number, body: (query: VaultQuery) => Promise<T>) =>
        seams.transaction(vault, budgetMs, body),
      now: seams.now,
    });
  }
  return Object.freeze({
    customerEnsure: (env: unknown, operationId: unknown, budgetMs: unknown) =>
      held(async () => {
        await switchedOn(env);
        writeInputs(operationId, budgetMs);
        const deps = await dependencies(env);
        return encodeStripeCustomerResult(
          await stripeCustomerEnsure(deps, operationId as string, budgetMs as number),
        );
      }),
    checkoutCreate: (env: unknown, operationId: unknown, budgetMs: unknown) =>
      held(async () => {
        await switchedOn(env);
        writeInputs(operationId, budgetMs);
        const deps = await dependencies(env);
        return encodeStripeCheckoutResult(
          await stripeCheckoutCreate(deps, operationId as string, budgetMs as number),
        );
      }),
    portalCreate: (env: unknown, operationId: unknown, budgetMs: unknown) =>
      held(async () => {
        await switchedOn(env);
        writeInputs(operationId, budgetMs);
        const deps = await dependencies(env);
        return encodeStripePortalResult(
          await stripePortalCreate(deps, operationId as string, budgetMs as number),
        );
      }),
    webhookVerify: (
      env: unknown,
      rawBodyBase64: unknown,
      signatureHeader: unknown,
      budgetMs: unknown,
    ) =>
      held(async () => {
        await switchedOn(env);
        if (
          typeof rawBodyBase64 !== "string" ||
          rawBodyBase64.length === 0 ||
          rawBodyBase64.length > stripeLimits.webhookBase64MaxBytes ||
          typeof signatureHeader !== "string" ||
          signatureHeader.length === 0 ||
          signatureHeader.length > stripeLimits.signatureMaxBytes
        )
          throw new BrokerHold("INPUT_INVALID");
        if (!stripeBudgetValid(budgetMs)) throw new BrokerHold("BUDGET_INVALID");
        const deps = await dependencies(env);
        return encodeStripeWebhookResult(
          await stripeWebhookVerify(
            deps,
            rawBodyBase64,
            signatureHeader,
            budgetMs as number,
            // One fixed line per refusal or hold: the reason and, once known, the
            // subscribed event type (object_invalid is held, so Stripe retries); never
            // provider text.
            (reason, eventType) =>
              console.log(
                JSON.stringify({
                  event: "morrow_broker_stripe_webhook",
                  verdict: reason === "object_invalid" ? "held" : "rejected",
                  reason,
                  eventType,
                }),
              ),
          ),
        );
      }),
  });
}

const live = createStripeBroker({
  transaction: runVaultTransaction,
  fetch: (request) => fetch(request),
  now: () => Date.now(),
});

export function brokerStripeCustomerEnsure(env: unknown, operationId: unknown, budgetMs: unknown) {
  return invokeBrokerMethod("stripeCustomerEnsure", () =>
    live.customerEnsure(env, operationId, budgetMs),
  );
}
export function brokerStripeCheckoutCreate(env: unknown, operationId: unknown, budgetMs: unknown) {
  return invokeBrokerMethod("stripeCheckoutCreate", () =>
    live.checkoutCreate(env, operationId, budgetMs),
  );
}
export function brokerStripePortalCreate(env: unknown, operationId: unknown, budgetMs: unknown) {
  return invokeBrokerMethod("stripePortalCreate", () =>
    live.portalCreate(env, operationId, budgetMs),
  );
}
export function brokerStripeWebhookVerify(
  env: unknown,
  rawBodyBase64: unknown,
  signatureHeader: unknown,
  budgetMs: unknown,
) {
  return invokeBrokerMethod("stripeWebhookVerify", () =>
    live.webhookVerify(env, rawBodyBase64, signatureHeader, budgetMs),
  );
}
