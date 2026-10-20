import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ApiBrokerRpc,
  ChallengeVerdict,
  ConnectorBrokerRpc,
  RuntimeBrokerRpc,
} from "../../../packages/identity/src/broker-protocol.js";
import { brokerCallerHealth, brokerHealth, brokerInputInvalid } from "./capabilities.js";
import { brokerChallengeVerify } from "./challenge.js";
import { brokerNeonLease } from "./neon-lease.js";
import {
  brokerStripeCheckoutCreate,
  brokerStripeCustomerEnsure,
  brokerStripePortalCreate,
  brokerStripeWebhookVerify,
} from "./stripe-broker.js";
import { brokerWorkosSessionPage } from "./workos-session.js";

// Reachable only through its service-binding entrypoints (ADR-0007; trust model v1,
// ADR-0022 item 7): one class per caller, each exposing only that caller's methods.
// Each method checks its arity and forwards to a module-scope handler. Results are
// strings or booleans only.

// The api Worker's entrypoint: exactly eight prototype methods (v0's four, ADR-0019 item 6
// added challengeVerify; M5 PR-1 adds the four Stripe methods, which take ids, strings and
// budgets only, as v1 requires: the broker loads every Stripe parameter itself).
export class ApiBroker extends WorkerEntrypoint<unknown> implements ApiBrokerRpc {
  health(): Promise<boolean> {
    return arguments.length === 0 ? brokerHealth(this.env) : brokerInputInvalid("health");
  }
  neonLease(namespaceJson: string): Promise<string> {
    return arguments.length === 1
      ? brokerNeonLease(this.env, namespaceJson)
      : brokerInputInvalid("neonLease");
  }
  workosSessionPage(
    namespaceJson: string,
    selectorJson: string,
    budgetMs: number,
  ): Promise<string> {
    return arguments.length === 3
      ? brokerWorkosSessionPage(this.env, namespaceJson, selectorJson, budgetMs)
      : brokerInputInvalid("workosSessionPage");
  }
  challengeVerify(action: string, token: string, budgetMs: number): Promise<ChallengeVerdict> {
    return arguments.length === 3
      ? brokerChallengeVerify(this.env, action, token, budgetMs)
      : brokerInputInvalid("challengeVerify");
  }
  stripeCustomerEnsure(operationId: string, budgetMs: number): Promise<string> {
    return arguments.length === 2
      ? brokerStripeCustomerEnsure(this.env, operationId, budgetMs)
      : brokerInputInvalid("stripeCustomerEnsure");
  }
  stripeCheckoutCreate(operationId: string, budgetMs: number): Promise<string> {
    return arguments.length === 2
      ? brokerStripeCheckoutCreate(this.env, operationId, budgetMs)
      : brokerInputInvalid("stripeCheckoutCreate");
  }
  stripePortalCreate(operationId: string, budgetMs: number): Promise<string> {
    return arguments.length === 2
      ? brokerStripePortalCreate(this.env, operationId, budgetMs)
      : brokerInputInvalid("stripePortalCreate");
  }
  stripeWebhookVerify(
    rawBodyBase64: string,
    signatureHeader: string,
    budgetMs: number,
  ): Promise<string> {
    return arguments.length === 3
      ? brokerStripeWebhookVerify(this.env, rawBodyBase64, signatureHeader, budgetMs)
      : brokerInputInvalid("stripeWebhookVerify");
  }
}

// The connector Worker's entrypoint (M2 PR-1): its health and its own role lease only.
// The Shopify methods join in M2 PR-2/PR-3, with their database definers.
export class ConnectorBroker extends WorkerEntrypoint<unknown> implements ConnectorBrokerRpc {
  health(): Promise<boolean> {
    return arguments.length === 0
      ? brokerCallerHealth(this.env, "connector")
      : brokerInputInvalid("health", "ConnectorBroker");
  }
  neonLease(namespaceJson: string): Promise<string> {
    return arguments.length === 1
      ? brokerNeonLease(this.env, namespaceJson, "connector")
      : brokerInputInvalid("neonLease", "ConnectorBroker");
  }
}

// The orchestrator's entrypoint (M2 PR-1): its health and its own role lease only.
// shopifyRead, modelRespond and the write methods join in M2 PR-3, M3 and M4.
export class RuntimeBroker extends WorkerEntrypoint<unknown> implements RuntimeBrokerRpc {
  health(): Promise<boolean> {
    return arguments.length === 0
      ? brokerCallerHealth(this.env, "runtime")
      : brokerInputInvalid("health", "RuntimeBroker");
  }
  neonLease(namespaceJson: string): Promise<string> {
    return arguments.length === 1
      ? brokerNeonLease(this.env, namespaceJson, "runtime")
      : brokerInputInvalid("neonLease", "RuntimeBroker");
  }
}

// No public route: every method and path is 404.
export default {
  fetch(): Response {
    return new Response('{"code":"not_found"}', {
      status: 404,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
};
