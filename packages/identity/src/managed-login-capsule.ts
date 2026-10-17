import {
  loginBytes,
  loginFailure,
  loginTime,
  loginUuid,
  type LoginAttempt,
} from "./standalone-login-protocol.js";
import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";

// Source-private composition only. Tokens expose neither material nor policy;
// their runtime authority is exact identity in these maps, not the TS brand.
declare const definitionBrand: unique symbol;
declare const resolvedBrand: unique symbol;
export type ManagedLoginKeyringDefinition = Readonly<{ [definitionBrand]: true }>;
export type ResolvedManagedLoginKeyring = Readonly<{ [resolvedBrand]: true }>;
export type SelectedManagedLoginKey = Readonly<{ keyId: string; key: CryptoKey }>;
type Version = Readonly<{
  keyId: string;
  material: string;
  encryptFromMs: number;
  encryptUntilMs: number;
  decryptUntilMs: number;
}>;
type Definition = Readonly<{
  configurationDigest: string;
  currentKeyId: string;
  versions: readonly Version[];
}>;
type Resolved = Readonly<{
  definition: Definition;
  keys: readonly SelectedManagedLoginKey[];
}>;
const definitions = new WeakMap<ManagedLoginKeyringDefinition, Definition>();
const resolved = new WeakMap<ResolvedManagedLoginKeyring, Resolved>();
const rootKeys = ["schemaVersion", "purpose", "configurationDigest", "currentKeyId", "versions"];
const versionKeys = ["keyId", "material", "encryptFromMs", "encryptUntilMs", "decryptUntilMs"];
const uuid = (value: unknown): value is string =>
  typeof value === "string" && value.length === 36 && loginUuid(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw loginFailure();
  return value as Record<string, unknown>;
}
function definition(handle: ManagedLoginKeyringDefinition): Definition {
  const value = definitions.get(handle);
  if (!value) throw loginFailure();
  return value;
}
function imported(handle: ResolvedManagedLoginKeyring): Resolved {
  const value = resolved.get(handle);
  if (!value) throw loginFailure();
  return value;
}
function current(value: Definition): Version {
  return value.versions.find((version) => version.keyId === value.currentKeyId)!;
}
function sealEligible(version: Version, at: number): void {
  if (at < version.encryptFromMs || at >= version.encryptUntilMs) throw loginFailure();
}
function coveredExpiry(version: Version, at: number, expiry: number): void {
  if (!loginTime(expiry) || expiry <= at || expiry > version.decryptUntilMs) throw loginFailure();
}

export function parseManagedLoginKeyring(
  keyringJson: unknown,
  expectedConfigurationDigest: string,
): ManagedLoginKeyringDefinition {
  try {
    if (!digest(expectedConfigurationDigest)) throw loginFailure();
    const row = record(parseWorkosSessionStatusJson(keyringJson, 4096), rootKeys);
    if (
      row.schemaVersion !== 1 ||
      row.purpose !== "morrow.login.capsule/1" ||
      !digest(row.configurationDigest) ||
      row.configurationDigest !== expectedConfigurationDigest ||
      !uuid(row.currentKeyId) ||
      !Array.isArray(row.versions) ||
      row.versions.length < 1 ||
      row.versions.length > 2
    )
      throw loginFailure();
    const ids = new Set<string>(),
      materials = new Set<string>();
    const versions = row.versions.map((entry): Version => {
      const version = record(entry, versionKeys);
      if (
        !uuid(version.keyId) ||
        typeof version.material !== "string" ||
        version.material.length !== 43 ||
        !loginTime(version.encryptFromMs) ||
        !loginTime(version.encryptUntilMs) ||
        !loginTime(version.decryptUntilMs) ||
        !loginTime(version.encryptUntilMs + 300000) ||
        version.encryptFromMs >= version.encryptUntilMs ||
        version.encryptUntilMs > version.decryptUntilMs ||
        version.decryptUntilMs > version.encryptUntilMs + 300000 ||
        ids.has(version.keyId) ||
        materials.has(version.material)
      )
        throw loginFailure();
      const bytes = loginBytes(version.material, 32);
      try {
        if (bytes.length !== 32) throw loginFailure();
      } finally {
        bytes.fill(0);
      }
      ids.add(version.keyId);
      materials.add(version.material);
      return Object.freeze({
        keyId: version.keyId,
        material: version.material,
        encryptFromMs: version.encryptFromMs,
        encryptUntilMs: version.encryptUntilMs,
        decryptUntilMs: version.decryptUntilMs,
      });
    });
    if (!ids.has(row.currentKeyId)) throw loginFailure();
    const token = Object.freeze({}) as ManagedLoginKeyringDefinition;
    definitions.set(
      token,
      Object.freeze({
        configurationDigest: row.configurationDigest,
        currentKeyId: row.currentKeyId,
        versions: Object.freeze(versions),
      }),
    );
    return token;
  } catch {
    throw loginFailure();
  }
}

export async function importManagedLoginKeyring(
  handle: ManagedLoginKeyringDefinition,
  originalAttempt: LoginAttempt,
): Promise<ResolvedManagedLoginKeyring> {
  try {
    const value = definition(handle),
      keys: SelectedManagedLoginKey[] = [];
    originalAttempt.check();
    // Temporal eligibility belongs to selection. An old callback can be valid
    // even when the current encrypting version is not currently eligible.
    for (const version of value.versions) {
      originalAttempt.check();
      const bytes = loginBytes(version.material, 32);
      try {
        originalAttempt.check();
        const pending = crypto.subtle.importKey(
          "raw",
          bytes,
          { name: "AES-GCM" },
          false,
          version.keyId === value.currentKeyId ? ["encrypt", "decrypt"] : ["decrypt"],
        );
        // wait checks authority before attaching its race handlers. A started
        // native operation still needs a sink if that first check now fails.
        void pending.catch(() => {});
        const key = await originalAttempt.wait(pending);
        originalAttempt.check();
        keys.push(Object.freeze({ keyId: version.keyId, key }));
      } finally {
        bytes.fill(0);
      }
    }
    originalAttempt.check();
    const token = Object.freeze({}) as ResolvedManagedLoginKeyring;
    resolved.set(token, Object.freeze({ definition: value, keys: Object.freeze(keys) }));
    return token;
  } catch {
    throw loginFailure();
  }
}

export function assertManagedLoginSealEligibility(
  handle: ManagedLoginKeyringDefinition | ResolvedManagedLoginKeyring,
  originalAttempt: LoginAttempt,
): void {
  try {
    const value =
      definitions.get(handle as ManagedLoginKeyringDefinition) ??
      imported(handle as ResolvedManagedLoginKeyring).definition;
    sealEligible(current(value), originalAttempt.check());
  } catch {
    throw loginFailure();
  }
}

export function selectManagedLoginSealKey(
  handle: ResolvedManagedLoginKeyring,
  originalAttempt: LoginAttempt,
  fixedFlowExpiryMs: number,
): SelectedManagedLoginKey {
  try {
    const value = imported(handle),
      version = current(value.definition),
      at = originalAttempt.check();
    sealEligible(version, at);
    coveredExpiry(version, at, fixedFlowExpiryMs);
    return value.keys.find((key) => key.keyId === version.keyId)!;
  } catch {
    throw loginFailure();
  }
}

export function selectManagedLoginOpenKey(
  handle: ResolvedManagedLoginKeyring,
  claimedKeyId: string,
  originalAttempt: LoginAttempt,
  fixedFlowExpiryMs: number,
): SelectedManagedLoginKey {
  try {
    const value = imported(handle),
      at = originalAttempt.check();
    if (!uuid(claimedKeyId)) throw loginFailure();
    const version = value.definition.versions.find((entry) => entry.keyId === claimedKeyId);
    if (!version || at < version.encryptFromMs || at >= version.decryptUntilMs)
      throw loginFailure();
    coveredExpiry(version, at, fixedFlowExpiryMs);
    return value.keys.find((key) => key.keyId === claimedKeyId)!;
  } catch {
    throw loginFailure();
  }
}
