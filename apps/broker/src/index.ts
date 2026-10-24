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
  brokerShopifyCredentialDestroy,
  brokerShopifyDisconnectDestroy,
  brokerShopifyInstallComplete,
  brokerShopifyLaunchVerify,
  brokerShopifyWebhookVerify,
} from "./shopify-install.js";
import { brokerShopifyRead } from "./shopify-read.js";
import {
  brokerShopifyProductApply,
  brokerShopifyProductReconcile,
  brokerShopifyProductUndoCheck,
} from "./shopify-write.js";
import {
  brokerStripeCheckoutCreate,
  brokerStripeCustomerEnsure,
  brokerStripePortalCreate,
  brokerStripeWebhookVerify,
} from "./stripe-broker.js";
import { brokerWorkosSessionPage } from "./workos-session.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import { createModelGateway } from "./model-gateway.js";
import { createRuntimeGateway } from "./runtime-gateway.js";
import { createVaultRuntimeLedger } from "./runtime-ledger.js";
import { runVaultTransaction } from "./vault-database.js";

// M3 PR-2: the model gateway on the vault login's real transport, the platform fetch and
// the clock. Claude is the only provider adapter (ADR-0022 item 10).
const modelGateway = createModelGateway({
  transaction: runVaultTransaction,
  providers: Object.freeze({ anthropic: createClaudeAdapter((request) => fetch(request)) }),
  now: () => Date.now(),
});
// Build order PR 7 (ADR-0029): the computer's door on the vault login's operation ledger. No
// runtime adapter is composed (the E2B adapter is PR 8's; the fake is tests-only), no template
// is pinned (PR 8's owner-run build) and nothing is qualified (PR 9), so even with the switch
// on every execute holds RUNTIME_UNAVAILABLE and no sandbox is ever counted as absent.
const runtimeGateway = createRuntimeGateway({
  ledger: (vault) => createVaultRuntimeLedger(vault, runVaultTransaction),
  providers: Object.freeze({}),
  now: () => Date.now(),
  template: null,
  qualified: false,
});

// Reachable only through its service-binding entrypoints (ADR-0007; trust model v1,
// ADR-0022 item 7): one class per caller, each exposing only that caller's methods.
// Each method checks its arity and forwards to a module-scope handler. Results are
// strings or booleans only.

// The api Worker's entrypoint: exactly thirteen prototype methods (v0's four, ADR-0019 item 6
// added challengeVerify; M5 PR-1 adds the four Stripe methods, which take ids, strings and
// budgets only, as v1 requires: the broker loads every Stripe parameter itself; M2 PR-3 adds
// shopifyRead under a read lease; "Disconnect store" adds shopifyCredentialDestroy, the
// disconnected installation's token, with its reason fixed; v1 PR 3 adds the gateway's
// shopifyProductApply and shopifyProductReconcile, keyed by one operation id; v1 PR 4 adds
// shopifyProductUndoCheck, keyed the same way).
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
  shopifyRead(
    leaseId: string,
    generation: number,
    subjectId: string,
    queryName: string,
    variablesJson: string,
    budgetMs: number,
  ): Promise<string> {
    return arguments.length === 6
      ? brokerShopifyRead(
          this.env,
          "api",
          leaseId,
          generation,
          subjectId,
          queryName,
          variablesJson,
          budgetMs,
        )
      : brokerInputInvalid("shopifyRead");
  }
  shopifyCredentialDestroy(installationId: string): Promise<string> {
    return arguments.length === 1
      ? brokerShopifyDisconnectDestroy(this.env, installationId)
      : brokerInputInvalid("shopifyCredentialDestroy");
  }
  // v1 PR 3: the gateway's apply of one dispatching catalog_write operation and its read-back
  // (ids and a budget only; the switch first, then everything from the database).
  shopifyProductApply(operationId: string, budgetMs: number): Promise<string> {
    return arguments.length === 2
      ? brokerShopifyProductApply(this.env, operationId, budgetMs)
      : brokerInputInvalid("shopifyProductApply");
  }
  shopifyProductReconcile(operationId: string, budgetMs: number): Promise<string> {
    return arguments.length === 2
      ? brokerShopifyProductReconcile(this.env, operationId, budgetMs)
      : brokerInputInvalid("shopifyProductReconcile");
  }
  // v1 PR 4: the undo check of one verified catalog_write operation (ids and a budget only).
  shopifyProductUndoCheck(operationId: string, budgetMs: number): Promise<string> {
    return arguments.length === 2
      ? brokerShopifyProductUndoCheck(this.env, operationId, budgetMs)
      : brokerInputInvalid("shopifyProductUndoCheck");
  }
}

// The connector Worker's entrypoint (M2 PR-1): its health and its own role lease. M2 PR-2
// adds the three Shopify methods (ADR-0008 item 2, item 1 as amended): the launch and
// webhook signature checks and the install's claim, exchange, identity read and vault
// write. M2 PR-3 makes the webhook check record the delivery and adds the token's
// destruction (shopifyRead is the api's and the orchestrator's, never the connector's).
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
  shopifyLaunchVerify(appKey: string, rawQuery: string): Promise<string> {
    return arguments.length === 2
      ? brokerShopifyLaunchVerify(this.env, appKey, rawQuery)
      : brokerInputInvalid("shopifyLaunchVerify", "ConnectorBroker");
  }
  shopifyInstallComplete(
    appKey: string,
    rawCallbackQuery: string,
    stateDigest: string,
    budgetMs: number,
  ): Promise<string> {
    return arguments.length === 4
      ? brokerShopifyInstallComplete(this.env, appKey, rawCallbackQuery, stateDigest, budgetMs)
      : brokerInputInvalid("shopifyInstallComplete", "ConnectorBroker");
  }
  shopifyWebhookVerify(
    appKey: string,
    headersJson: string,
    rawBodyBase64: string,
  ): Promise<string> {
    return arguments.length === 3
      ? brokerShopifyWebhookVerify(this.env, appKey, headersJson, rawBodyBase64)
      : brokerInputInvalid("shopifyWebhookVerify", "ConnectorBroker");
  }
  shopifyCredentialDestroy(installationId: string, reason: string): Promise<string> {
    return arguments.length === 2
      ? brokerShopifyCredentialDestroy(this.env, installationId, reason)
      : brokerInputInvalid("shopifyCredentialDestroy", "ConnectorBroker");
  }
}

// The orchestrator's entrypoint (M2 PR-1): its health and its own role lease. M2 PR-3 adds
// shopifyRead (productContent under a run lease) and M3 PR-2 modelRespond (the
// provider-neutral model gateway); build order PR 7 the computer's runtimeExecute and
// runtimeSweep; the write methods join in M4.
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
  shopifyRead(
    leaseId: string,
    generation: number,
    subjectId: string,
    queryName: string,
    variablesJson: string,
    budgetMs: number,
  ): Promise<string> {
    return arguments.length === 6
      ? brokerShopifyRead(
          this.env,
          "runtime",
          leaseId,
          generation,
          subjectId,
          queryName,
          variablesJson,
          budgetMs,
        )
      : brokerInputInvalid("shopifyRead", "RuntimeBroker");
  }
  modelRespond(
    leaseId: string,
    generation: number,
    callJson: string,
    budgetMs: number,
  ): Promise<string> {
    return arguments.length === 4
      ? modelGateway.modelRespond(this.env, leaseId, generation, callJson, budgetMs)
      : brokerInputInvalid("modelRespond", "RuntimeBroker");
  }
  runtimeExecute(
    leaseId: string,
    generation: number,
    jobJson: string,
    budgetMs: number,
  ): Promise<string> {
    return arguments.length === 4
      ? runtimeGateway.runtimeExecute(this.env, leaseId, generation, jobJson, budgetMs)
      : brokerInputInvalid("runtimeExecute", "RuntimeBroker");
  }
  runtimeSweep(budgetMs: number): Promise<string> {
    return arguments.length === 1
      ? runtimeGateway.runtimeSweep(this.env, budgetMs)
      : brokerInputInvalid("runtimeSweep", "RuntimeBroker");
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
