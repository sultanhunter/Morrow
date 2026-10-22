// The broker vault (ADR-0022 item 7; mvp-architecture §4 and §6; migration 0020).
// AES-256-GCM envelope encryption: every record has its own random 32-byte data key,
// sealed under a versioned key-encryption key (KEK) that lives only in broker secrets
// (`MORROW_VAULT_KEK_V<n>`) and in the owner's offline copy. The additional data binds
// the purpose (wrap or seal), the environment, the record's kind, tenant, identity,
// provider and version, and the KEK version, so a row never opens in another
// environment, tenant, record, version or under another KEK. Rows hold only
// metadata and the two sealed byte strings (morrow_vault.app_secrets, .credentials).
//
// Decryption happens only in the broker. The owner-run vault script (scripts/vault.mjs)
// seals an app's client secret with this module and the offline KEK copy. Nothing here
// logs, and every failure is one fixed VaultError code with no value, key or byte in it.
// Uses only WebCrypto, so the same code runs in workerd and in Node 24.

import { billingVaultStatements } from "./vault-statements-billing.js";
import { modelVaultStatements } from "./vault-statements-model.js";
import { shopifyVaultStatements } from "./vault-statements-shopify.js";

// Trust model v1 custody covers development and staging only (ADR-0022 item 7). Production
// custody needs its own ADR (ADR-0007 item 9), so no keyring, envelope or additional data
// exists for production until that ADR adds it here.
export type VaultEnvironment = "development" | "staging";
export const vaultEnvironments: readonly VaultEnvironment[] = Object.freeze([
  "development",
  "staging",
]);
// The byte limits of the 0020 CHECK constraints: wrapped_key is a 12-byte IV, the
// 32-byte data key and a 16-byte tag (60); sealed_value is an IV, 1-4096 bytes of
// ciphertext and a tag (29-4124).
export const vaultLimits = Object.freeze({
  keyBytes: 32,
  ivBytes: 12,
  tagBytes: 16,
  wrappedKeyBytes: 60,
  plaintextMaxBytes: 4096,
  sealedMinBytes: 29,
  sealedMaxBytes: 4124,
  kekVersionMax: 999,
});
export type VaultErrorCode =
  | "VAULT_INPUT_INVALID"
  | "VAULT_KEK_UNAVAILABLE"
  | "VAULT_OPEN_FAILED"
  | "VAULT_RECORD_INVALID"
  // M2 PR-2, the vault transport (vault-database.ts): the database could not be used, a
  // statement outside the registry was refused, or a COMMIT was sent and its
  // acknowledgement lost (never retried; the caller reconciles by its own ids).
  | "VAULT_DATABASE_UNAVAILABLE"
  | "VAULT_STATEMENT_DENIED"
  | "VAULT_OUTCOME_UNKNOWN";
export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode) {
    super(code);
    this.name = "VaultError";
  }
}

// The two record kinds of migration 0020. An app secret is a platform row keyed by its
// app key; an offline token is a tenant row keyed by its credential id, and it keeps its
// subject (the store installation) across versions.
export type VaultRecordRef =
  | {
      readonly kind: "app_secret";
      readonly appKey: string;
      readonly provider: "shopify";
      readonly version: number;
    }
  | {
      readonly kind: "shopify_offline_token";
      readonly organizationId: string;
      readonly workspaceId: string;
      readonly credentialId: string;
      readonly subjectId: string;
      readonly provider: "shopify";
      readonly version: number;
    };
export interface VaultEnvelope {
  readonly kekVersion: number;
  readonly wrappedKey: Uint8Array;
  readonly sealedValue: Uint8Array;
}
/** An issued keyring: the KEKs are non-extractable CryptoKeys held outside the object. */
export interface VaultKeyring {
  readonly environment: VaultEnvironment;
  /** The version new records are sealed under: the highest one held. */
  readonly sealingKekVersion: number;
  readonly kekVersions: readonly number[];
}

const invalid = () => new VaultError("VAULT_INPUT_INVALID");
const encoder = new TextEncoder();
const appKeyPattern = /^[a-z0-9][a-z0-9-]{2,62}$/;
const recordIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// A KEK secret is exactly 32 random bytes as 64 lowercase hex characters.
const kekPattern = /^[0-9a-f]{64}$/;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
const version = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const kekVersion = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= vaultLimits.kekVersionMax;
const keys = new WeakMap<object, ReadonlyMap<number, CryptoKey>>();

function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(value.length);
  out.set(value);
  return out;
}
function bytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}
export function vaultHexBytes(hex: unknown, minimum: number, maximum: number): Uint8Array {
  if (
    typeof hex !== "string" ||
    hex.length % 2 !== 0 ||
    hex.length < minimum * 2 ||
    hex.length > maximum * 2 ||
    !/^[0-9a-f]*$/.test(hex)
  )
    throw new VaultError("VAULT_RECORD_INVALID");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function vaultBytesHex(value: Uint8Array): string {
  let hex = "";
  for (const byte of value) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function parseRef(ref: unknown): VaultRecordRef {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw invalid();
  const r = ref as Record<string, unknown>;
  const names = Object.keys(r).sort().join(",");
  if (
    r.kind === "app_secret" &&
    names === "appKey,kind,provider,version" &&
    exact(appKeyPattern, r.appKey) &&
    r.provider === "shopify" &&
    version(r.version)
  )
    return Object.freeze({
      kind: "app_secret",
      appKey: r.appKey,
      provider: "shopify",
      version: r.version,
    });
  if (
    r.kind === "shopify_offline_token" &&
    names === "credentialId,kind,organizationId,provider,subjectId,version,workspaceId" &&
    [r.organizationId, r.workspaceId, r.credentialId, r.subjectId].every((v) =>
      exact(recordIdPattern, v),
    ) &&
    r.provider === "shopify" &&
    version(r.version)
  )
    return Object.freeze({
      kind: "shopify_offline_token",
      organizationId: r.organizationId as string,
      workspaceId: r.workspaceId as string,
      credentialId: r.credentialId as string,
      subjectId: r.subjectId as string,
      provider: "shopify",
      version: r.version,
    });
  throw invalid();
}

/**
 * The additional data of one AES-GCM operation: a canonical JSON array of the purpose,
 * the environment, the record's kind, tenant (null for a platform row), identity and
 * subject (null for an app secret), provider, version and KEK version.
 */
export function vaultAdditionalData(
  environment: VaultEnvironment,
  ref: VaultRecordRef,
  kek: number,
  purpose: "wrap" | "seal",
): Uint8Array<ArrayBuffer> {
  if (
    !vaultEnvironments.includes(environment) ||
    !kekVersion(kek) ||
    (purpose !== "wrap" && purpose !== "seal")
  )
    throw invalid();
  const r = parseRef(ref);
  const tenant = r.kind === "app_secret" ? [null, null] : [r.organizationId, r.workspaceId];
  const record = r.kind === "app_secret" ? [r.appKey, null] : [r.credentialId, r.subjectId];
  return owned(
    encoder.encode(
      JSON.stringify([
        "morrow.vault.v1",
        purpose,
        environment,
        r.kind,
        ...tenant,
        ...record,
        r.provider,
        r.version,
        kek,
      ]),
    ),
  );
}

/**
 * Imports the KEKs as non-extractable AES-GCM keys and issues a keyring. `keks` maps
 * each KEK version to its 64-hex secret. Throws VAULT_KEK_UNAVAILABLE for an unknown
 * environment, an empty set, a bad version or a malformed secret.
 */
export async function createVaultKeyring(
  environment: unknown,
  keks: ReadonlyMap<number, unknown>,
): Promise<VaultKeyring> {
  try {
    if (
      typeof environment !== "string" ||
      !(vaultEnvironments as readonly string[]).includes(environment) ||
      !(keks instanceof Map) ||
      keks.size === 0 ||
      keks.size > 8
    )
      throw Error();
    const imported = new Map<number, CryptoKey>();
    for (const [v, secret] of keks) {
      if (!kekVersion(v) || !exact(kekPattern, secret)) throw Error();
      const raw = vaultHexBytes(secret, vaultLimits.keyBytes, vaultLimits.keyBytes);
      try {
        imported.set(
          v,
          await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
            "encrypt",
            "decrypt",
          ]),
        );
      } finally {
        raw.fill(0);
      }
    }
    const versions = Object.freeze([...imported.keys()].sort((a, b) => a - b));
    const keyring: VaultKeyring = Object.freeze({
      environment: environment as VaultEnvironment,
      sealingKekVersion: versions.at(-1)!,
      kekVersions: versions,
    });
    keys.set(keyring, imported);
    return keyring;
  } catch {
    throw new VaultError("VAULT_KEK_UNAVAILABLE");
  }
}

function kekOf(keyring: VaultKeyring, v: number): CryptoKey {
  const held = keys.get(keyring);
  if (!held) throw new VaultError("VAULT_KEK_UNAVAILABLE");
  const key = held.get(v);
  if (!key) throw new VaultError("VAULT_KEK_UNAVAILABLE");
  return key;
}
async function gcm(
  direction: "encrypt" | "decrypt",
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const algorithm = { name: "AES-GCM", iv, additionalData, tagLength: 128 };
  return new Uint8Array(
    direction === "encrypt"
      ? await crypto.subtle.encrypt(algorithm, key, data)
      : await crypto.subtle.decrypt(algorithm, key, data),
  );
}
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * Seals one record under the keyring's sealing KEK: a fresh data key wraps nothing but
 * this plaintext (1-4096 bytes). Throws VAULT_INPUT_INVALID for a bad ref or size and
 * VAULT_KEK_UNAVAILABLE for a keyring this module did not issue.
 */
export async function sealVaultRecord(
  keyring: VaultKeyring,
  ref: VaultRecordRef,
  plaintext: Uint8Array,
): Promise<VaultEnvelope> {
  const r = parseRef(ref);
  if (
    !(plaintext instanceof Uint8Array) ||
    plaintext.length < 1 ||
    plaintext.length > vaultLimits.plaintextMaxBytes
  )
    throw invalid();
  const v = keyring.sealingKekVersion;
  const kek = kekOf(keyring, v);
  const dataKey = bytes(vaultLimits.keyBytes);
  try {
    const wrapIv = bytes(vaultLimits.ivBytes);
    const sealIv = bytes(vaultLimits.ivBytes);
    const wrapped = concat(
      wrapIv,
      await gcm(
        "encrypt",
        kek,
        wrapIv,
        dataKey,
        vaultAdditionalData(keyring.environment, r, v, "wrap"),
      ),
    );
    const key = await crypto.subtle.importKey("raw", dataKey, { name: "AES-GCM" }, false, [
      "encrypt",
    ]);
    const sealed = concat(
      sealIv,
      await gcm(
        "encrypt",
        key,
        sealIv,
        owned(plaintext),
        vaultAdditionalData(keyring.environment, r, v, "seal"),
      ),
    );
    return Object.freeze({ kekVersion: v, wrappedKey: wrapped, sealedValue: sealed });
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Opens one record. Any mismatch (environment, tenant, record, subject, version, KEK,
 * a changed byte or a swapped key) is the one fixed VAULT_OPEN_FAILED.
 */
export async function openVaultRecord(
  keyring: VaultKeyring,
  ref: VaultRecordRef,
  envelope: VaultEnvelope,
): Promise<Uint8Array> {
  const r = parseRef(ref);
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !kekVersion(envelope.kekVersion) ||
    !(envelope.wrappedKey instanceof Uint8Array) ||
    !(envelope.sealedValue instanceof Uint8Array) ||
    envelope.wrappedKey.length !== vaultLimits.wrappedKeyBytes ||
    envelope.sealedValue.length < vaultLimits.sealedMinBytes ||
    envelope.sealedValue.length > vaultLimits.sealedMaxBytes
  )
    throw new VaultError("VAULT_RECORD_INVALID");
  const kek = kekOf(keyring, envelope.kekVersion);
  let dataKey: Uint8Array<ArrayBuffer> | undefined;
  try {
    const iv = (value: Uint8Array) => owned(value.subarray(0, vaultLimits.ivBytes));
    const body = (value: Uint8Array) => owned(value.subarray(vaultLimits.ivBytes));
    dataKey = await gcm(
      "decrypt",
      kek,
      iv(envelope.wrappedKey),
      body(envelope.wrappedKey),
      vaultAdditionalData(keyring.environment, r, envelope.kekVersion, "wrap"),
    );
    if (dataKey.length !== vaultLimits.keyBytes) throw Error();
    const key = await crypto.subtle.importKey("raw", dataKey, { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    return await gcm(
      "decrypt",
      key,
      iv(envelope.sealedValue),
      body(envelope.sealedValue),
      vaultAdditionalData(keyring.environment, r, envelope.kekVersion, "seal"),
    );
  } catch {
    throw new VaultError("VAULT_OPEN_FAILED");
  } finally {
    dataKey?.fill(0);
  }
}

// ---------------------------------------------------------------------------
// The app-secret read path (M2 PR-2's launch and callback verification use it). The
// broker's own login, morrow_vault_broker, runs this one fixed statement; the definer
// returns the active envelope as hex and nothing else.
//
// vaultStatements is THE registry of statements the vault login may send: a frozen union
// of per-PR maps, each in its own module (M2 PR-2: Shopify; M5 PR-1: billing; M3 PR-2: the
// model gateway's fence). The vault
// transport (vault-database.ts) refuses any other text.
export const vaultStatements = Object.freeze({
  appSecretGet:
    "SELECT outcome,version,kek_version,wrapped_key,sealed_value FROM morrow_vault.app_secret_get($1)",
  ...shopifyVaultStatements,
  ...billingVaultStatements,
  ...modelVaultStatements,
} as const);
/** One fixed statement on a connection logged in as morrow_vault_broker. */
export type VaultQuery = (
  text: (typeof vaultStatements)[keyof typeof vaultStatements],
  values: readonly string[],
) => Promise<readonly Record<string, unknown>[]>;
export type AppSecretRead =
  | { readonly outcome: "found"; readonly version: number; readonly secret: string }
  | { readonly outcome: "not_found" };

const appSecretColumns = "kek_version,outcome,sealed_value,version,wrapped_key";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
/**
 * Reads and opens the active client secret of one app. A denied or invalid outcome, a
 * malformed row or a failed open is a VaultError; only `not_found` is an answer.
 */
export async function readAppSecret(
  keyring: VaultKeyring,
  query: VaultQuery,
  appKey: unknown,
): Promise<AppSecretRead> {
  if (!exact(appKeyPattern, appKey)) throw invalid();
  const rows = await query(vaultStatements.appSecretGet, [appKey]);
  if (!Array.isArray(rows) || rows.length !== 1) throw new VaultError("VAULT_RECORD_INVALID");
  const row = rows[0]!;
  if (Object.keys(row).sort().join(",") !== appSecretColumns)
    throw new VaultError("VAULT_RECORD_INVALID");
  if (row.outcome === "not_found") return Object.freeze({ outcome: "not_found" });
  if (
    row.outcome !== "found" ||
    !exact(/^[1-9][0-9]{0,15}$/, row.version) ||
    !exact(/^[1-9][0-9]{0,2}$/, row.kek_version)
  )
    throw new VaultError("VAULT_RECORD_INVALID");
  const v = Number(row.version);
  const plaintext = await openVaultRecord(
    keyring,
    { kind: "app_secret", appKey, provider: "shopify", version: v },
    {
      kekVersion: Number(row.kek_version),
      wrappedKey: vaultHexBytes(
        row.wrapped_key,
        vaultLimits.wrappedKeyBytes,
        vaultLimits.wrappedKeyBytes,
      ),
      sealedValue: vaultHexBytes(
        row.sealed_value,
        vaultLimits.sealedMinBytes,
        vaultLimits.sealedMaxBytes,
      ),
    },
  );
  try {
    return Object.freeze({ outcome: "found", version: v, secret: decoder.decode(plaintext) });
  } catch {
    throw new VaultError("VAULT_OPEN_FAILED");
  } finally {
    plaintext.fill(0);
  }
}
