import { createWorkersFixedWorkosLoginPort } from "../../../packages/identity/src/fixed-workos-login-port.js";
import { parseManagedLoginKeyring } from "../../../packages/identity/src/managed-login-capsule.js";
import type { FixedWorkosLoginPort } from "../../../packages/identity/src/standalone-login.js";
import {
  parseLoginConfiguration,
  type LoginControl,
} from "../../../packages/identity/src/standalone-login-protocol.js";
import { parseWorkosSessionStatusJson } from "../../../packages/identity/src/workos-session-status-json.js";
import { brokerControl, raceBrokerCall } from "./broker-client.js";

// The api's own keyless WorkOS port: the PKCE exchange POST and the JWKS GET
// (plan R1, P04.T02a bullet). Its local credential broker always rejects, so it
// can never obtain a key; the keyed session-catalogue read runs in the broker.

export type ApiKeyringReadiness =
  | "KEYRING_READY"
  | "KEYRING_EXPIRING"
  | "KEYRING_NOT_YET_VALID"
  | "KEYRING_EXPIRED"
  | "KEYRING_INVALID"
  | "PORT_UNAVAILABLE";
const day = 86400000;
const held = () => Error("API_WORKOS_PORT_HELD");
const deny = Object.freeze({
  borrow(_namespaceJson: string, _control: Readonly<LoginControl>): Promise<unknown> {
    return Promise.reject(Error("API_WORKOS_KEY_DENIED"));
  },
});
type Window = Readonly<{ encryptFromMs: number; encryptUntilMs: number }>;

export function createLazyWorkosLoginPort(configurationJson: string, now: () => number) {
  // One in-flight initialisation per isolate; a failed initialisation stays held.
  let port: Promise<Readonly<FixedWorkosLoginPort>> | undefined;
  const memoised = () => {
    if (!port) {
      port = createWorkersFixedWorkosLoginPort({
        configurationJson,
        sessionCredentialBroker: deny,
        now,
      });
      void port.catch(() => {});
    }
    return port;
  };
  const ready = async (supplied: Readonly<LoginControl>) => {
    const control = brokerControl(supplied);
    const remaining = control.deadlineMs - now();
    if (!(remaining > 0)) throw held();
    return raceBrokerCall(memoised, control.signal, remaining);
  };
  const windows = new Map<string, Promise<Window>>();
  const keyringWindow = (keyringJson: string) => {
    let pending = windows.get(keyringJson);
    if (!pending) {
      pending = (async () => {
        const configuration = await parseLoginConfiguration(configurationJson);
        parseManagedLoginKeyring(keyringJson, configuration.configurationDigest);
        const ring = parseWorkosSessionStatusJson(keyringJson, 4096) as {
          currentKeyId: string;
          versions: { keyId: string; encryptFromMs: number; encryptUntilMs: number }[];
        };
        const current = ring.versions.find((version) => version.keyId === ring.currentKeyId);
        if (!current) throw held();
        return Object.freeze({
          encryptFromMs: current.encryptFromMs,
          encryptUntilMs: current.encryptUntilMs,
        });
      })();
      void pending.catch(() => {});
      windows.set(keyringJson, pending);
    }
    return pending;
  };
  return Object.freeze({
    exchange: async (inputJson: string, control: Readonly<LoginControl>): Promise<string> =>
      (await ready(control)).exchange(inputJson, control),
    readPublicKeyset: async (control: Readonly<LoginControl>): Promise<string> =>
      (await ready(control)).readPublicKeyset(control),
    // Public readiness only: the port initialises and the keyring's current
    // version (bound to this configuration digest) can seal now.
    async readiness(keyringJson: string): Promise<ApiKeyringReadiness> {
      try {
        await memoised();
      } catch {
        return "PORT_UNAVAILABLE";
      }
      let window: Window;
      try {
        window = await keyringWindow(keyringJson);
      } catch {
        return "KEYRING_INVALID";
      }
      const at = now();
      if (at < window.encryptFromMs) return "KEYRING_NOT_YET_VALID";
      if (at >= window.encryptUntilMs) return "KEYRING_EXPIRED";
      if (window.encryptUntilMs - at < 14 * day) return "KEYRING_EXPIRING";
      return "KEYRING_READY";
    },
  });
}
