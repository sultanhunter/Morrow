import {
  brokerLimits,
  brokerUtf8Bytes,
  encodeNeonLeaseGrant,
  type BrokerCaller,
} from "../../../packages/identity/src/broker-protocol.js";
import {
  BrokerHold,
  brokerCapabilities,
  brokerEntrypoints,
  invokeBrokerMethod,
} from "./capabilities.js";

// Returns the role's static password for exactly one namespace of this broker's own
// binding and of the calling entrypoint's own roles (ADR-0022 item 7): the api's eight,
// the connector's one or the orchestrator's one. Byte equality, no parsing, no state,
// budget or retry. The password has no credential lifetime (ADR-0007 item 2).
export function brokerNeonLease(
  env: unknown,
  namespaceJson: unknown,
  caller: BrokerCaller = "api",
): Promise<string> {
  return invokeBrokerMethod(
    "neonLease",
    async () => {
      if (
        typeof namespaceJson !== "string" ||
        brokerUtf8Bytes(namespaceJson) > brokerLimits.namespaceMaxBytes
      )
        throw new BrokerHold("NAMESPACE_DENIED");
      const capabilities = await brokerCapabilities(env);
      const database =
        caller === "api"
          ? capabilities.database
          : caller === "connector"
            ? capabilities.connector
            : capabilities.runtime;
      if (!database) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
      const password = database.leases.get(namespaceJson);
      if (password === undefined) throw new BrokerHold("NAMESPACE_DENIED");
      return encodeNeonLeaseGrant(password);
    },
    brokerEntrypoints[caller],
  );
}
