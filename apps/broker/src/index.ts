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
  brokerShopifyInstallComplete,
  brokerShopifyLaunchVerify,
  brokerShopifyWebhookVerify,
} from "./shopify-install.js";
import { brokerWorkosSessionPage } from "./workos-session.js";

// Reachable only through its service-binding entrypoints (ADR-0007; trust model v1,
// ADR-0022 item 7): one class per caller, each exposing only that caller's methods.
// Each method checks its arity and forwards to a module-scope handler. Results are
// strings or booleans only.

// The api Worker's entrypoint: exactly four prototype methods (v0; ADR-0019 item 6
// added challengeVerify).
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
}

// The connector Worker's entrypoint (M2 PR-1): its health and its own role lease. M2 PR-2
// adds the three Shopify methods (ADR-0008 item 2, item 1 as amended): the launch and
// webhook signature checks and the install's claim, exchange, identity read and vault
// write. shopifyCredentialDestroy and shopifyRead join in M2 PR-3.
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
