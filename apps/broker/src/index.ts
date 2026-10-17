import { WorkerEntrypoint } from "cloudflare:workers";
import type { ApiBrokerRpc } from "../../../packages/identity/src/broker-protocol.js";
import { brokerHealth, brokerInputInvalid } from "./capabilities.js";
import { brokerNeonLease } from "./neon-lease.js";
import { brokerWorkosSessionPage } from "./workos-session.js";

// Reachable only through the `ApiBroker` service-binding entrypoint (ADR-0007).
// Exactly three prototype methods; each checks its arity and forwards to a
// module-scope handler. Results are strings or booleans only.
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
