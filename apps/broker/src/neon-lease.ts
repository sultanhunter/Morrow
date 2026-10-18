import {
  brokerLimits,
  brokerUtf8Bytes,
  encodeNeonLeaseGrant,
} from "../../../packages/identity/src/broker-protocol.js";
import { BrokerHold, brokerCapabilities, invokeBrokerMethod } from "./capabilities.js";

// Returns the role's static password for exactly one of the eight namespaces of
// this broker's own binding: byte equality, no parsing, no state, budget or retry.
// The password has no credential lifetime (ADR-0007 item 2).
export function brokerNeonLease(env: unknown, namespaceJson: unknown): Promise<string> {
  return invokeBrokerMethod("neonLease", async () => {
    if (
      typeof namespaceJson !== "string" ||
      brokerUtf8Bytes(namespaceJson) > brokerLimits.namespaceMaxBytes
    )
      throw new BrokerHold("NAMESPACE_DENIED");
    const capabilities = await brokerCapabilities(env);
    if (!capabilities.database) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
    const password = capabilities.database.leases.get(namespaceJson);
    if (password === undefined) throw new BrokerHold("NAMESPACE_DENIED");
    return encodeNeonLeaseGrant(password);
  });
}
