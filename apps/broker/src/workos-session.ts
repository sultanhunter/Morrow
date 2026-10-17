import { brokerLimits, brokerUtf8Bytes } from "../../../packages/identity/src/broker-protocol.js";
import { BrokerHold, brokerCapabilities, invokeBrokerMethod } from "./capabilities.js";

// The one keyed WorkOS call: the session-catalogue GET of the fixed login port,
// with the key borrowed broker-locally. exchange and readPublicKeyset are never
// exposed. Exactly one provider request per call; nothing is retried.
export function brokerWorkosSessionPage(
  env: unknown,
  namespaceJson: unknown,
  selectorJson: unknown,
  budgetMs: unknown,
): Promise<string> {
  return invokeBrokerMethod("workosSessionPage", async () => {
    const capabilities = await brokerCapabilities(env);
    const sessions = capabilities.sessions;
    if (!sessions) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
    if (typeof namespaceJson !== "string" || namespaceJson !== sessions.namespace)
      throw new BrokerHold("NAMESPACE_DENIED");
    if (
      typeof selectorJson !== "string" ||
      brokerUtf8Bytes(selectorJson) > brokerLimits.selectorMaxBytes
    )
      throw new BrokerHold("INPUT_INVALID");
    if (
      typeof budgetMs !== "number" ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < 1 ||
      budgetMs > brokerLimits.sessionPageMaxMs
    )
      throw new BrokerHold("BUDGET_INVALID");
    const abort = new AbortController();
    let page: unknown;
    try {
      page = await sessions.port.readSessionPage(
        selectorJson,
        Object.freeze({ deadlineMs: Date.now() + budgetMs, signal: abort.signal }),
      );
    } catch {
      throw new BrokerHold("PROVIDER_HELD");
    } finally {
      abort.abort();
    }
    if (typeof page !== "string" || brokerUtf8Bytes(page) > brokerLimits.sessionPageMaxBytes)
      throw new BrokerHold("PROVIDER_HELD");
    return page;
  });
}
