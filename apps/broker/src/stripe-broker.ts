import {
  encodeStripeCheckoutResult,
  encodeStripeCustomerResult,
  encodeStripePortalResult,
  encodeStripeWebhookResult,
  stripeBudgetValid,
  stripeLimits,
  stripeOperationIdValid,
} from "../../../packages/identity/src/broker-protocol.js";
import { BrokerHold, brokerCapabilities, invokeBrokerMethod } from "./capabilities.js";
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

// The ApiBroker's Stripe methods (M5 PR-1): module-scope handlers that check the closed
// inputs, build the Stripe dependencies from the broker's own capabilities (the restricted
// key and webhook secret never leave the broker) and return the closed result JSON. Every
// failure is BROKER_HELD with one fixed log line (invokeBrokerMethod).

async function dependencies(env: unknown): Promise<StripeDependencies> {
  const capabilities = await brokerCapabilities(env);
  const vault = capabilities.vault;
  const stripe = capabilities.stripe;
  if (!vault || !stripe) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
  return Object.freeze({
    stripe,
    fetch: (request: Request) => fetch(request),
    transaction: <T>(budgetMs: number, body: (query: VaultQuery) => Promise<T>) =>
      runVaultTransaction(vault, budgetMs, body),
    now: () => Date.now(),
  });
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

export function brokerStripeCustomerEnsure(env: unknown, operationId: unknown, budgetMs: unknown) {
  return invokeBrokerMethod("stripeCustomerEnsure", () =>
    held(async () => {
      writeInputs(operationId, budgetMs);
      const deps = await dependencies(env);
      return encodeStripeCustomerResult(
        await stripeCustomerEnsure(deps, operationId as string, budgetMs as number),
      );
    }),
  );
}
export function brokerStripeCheckoutCreate(env: unknown, operationId: unknown, budgetMs: unknown) {
  return invokeBrokerMethod("stripeCheckoutCreate", () =>
    held(async () => {
      writeInputs(operationId, budgetMs);
      const deps = await dependencies(env);
      return encodeStripeCheckoutResult(
        await stripeCheckoutCreate(deps, operationId as string, budgetMs as number),
      );
    }),
  );
}
export function brokerStripePortalCreate(env: unknown, operationId: unknown, budgetMs: unknown) {
  return invokeBrokerMethod("stripePortalCreate", () =>
    held(async () => {
      writeInputs(operationId, budgetMs);
      const deps = await dependencies(env);
      return encodeStripePortalResult(
        await stripePortalCreate(deps, operationId as string, budgetMs as number),
      );
    }),
  );
}
export function brokerStripeWebhookVerify(
  env: unknown,
  rawBodyBase64: unknown,
  signatureHeader: unknown,
  budgetMs: unknown,
) {
  return invokeBrokerMethod("stripeWebhookVerify", () =>
    held(async () => {
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
          // One fixed line per refusal or hold: the reason and, once known, the subscribed
          // event type (object_invalid is held, so Stripe retries); never provider text.
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
  );
}
