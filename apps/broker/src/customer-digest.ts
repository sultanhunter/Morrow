// SD4 (P09.T05c; docs/packets/P09.T05c.md): the keyed customer digests that customers/* requests
// are matched by, and the workspace's digest keys in the broker vault (ADR-0031 item 3: "a keyed
// email digest (key in the broker vault)"; ADR-0042 items 5 and 15: the workspace's digest key,
// HMAC-SHA-256, used only for caps, suppression and redaction, every version kept for the
// workspace's life).
//
// A digest is HMAC-SHA-256 under one version of the workspace's key over a domain-separated,
// versioned input: the customer id, the normalised email or the E.164 phone. Only the broker
// holds a key (it opens the vault row in its own transaction), so a digest leaves nothing a
// model, a log or another Worker could reverse. A request is matched under every kept version,
// so rotating the key never strands a digest written under an older one.
//
// The input functions are the one definition every writer of a digest uses: a class that stores
// a phone or email digest (ADR 0042's contact rows, CS9) computes it with these, under the
// workspace's current version, so a later customers/redact finds it. The email input is
// byte-for-byte the customer identifier screen's (H9a, `customerEmailDigestInput` in
// @morrow/policy's customer-screen), so the screen's keyed email list and this matcher agree.
// No `node:` import: this runs in the broker Worker.

import {
  openVaultRecord,
  sealVaultRecord,
  vaultBytesHex,
  VaultError,
  vaultHexBytes,
  vaultLimits,
  vaultStatements,
  type VaultKeyring,
  type VaultQuery,
} from "./vault.js";

/** The most key versions a workspace keeps (the vault row's CHECK). */
export const customerDigestKeyVersionsMax = 8;
/** One opened version of a workspace's digest key, as a non-extractable HMAC key. */
export interface CustomerDigestKey {
  readonly version: number;
  readonly key: CryptoKey;
}
/** The digests of one customer under one key version; null where the input was absent. */
export interface CustomerDigestSet {
  readonly version: number;
  readonly id: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

const label = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?";
const domainShape = new RegExp(`^(?:${label}\\.)+\\p{L}{2,24}$`, "u");

/** The input of a customer id's digest: a positive numeric id. Null otherwise. */
export function customerIdDigestInput(id: unknown): string | null {
  const text =
    typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? String(id)
      : typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id)
        ? id
        : null;
  return text === null ? null : "morrow.customer-id.v1|" + text;
}
/**
 * The input of an email's digest: NFKC, trimmed, lower case, a `+tag` dropped from the local
 * part, the domain without a trailing dot (H9a's customerEmailDigestInput, unchanged). Null when
 * it is not an email address.
 */
export function customerEmailDigestInput(email: unknown): string | null {
  if (typeof email !== "string" || email.length > 320) return null;
  const e = email.normalize("NFKC").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  let local = e.slice(0, at);
  const domain = e.slice(at + 1).replace(/\.$/u, "");
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (!/^[\p{L}\p{N}._%-]{1,64}$/u.test(local) || !domainShape.test(domain)) return null;
  return "morrow.customer-email.v1|" + local + "@" + domain;
}
/**
 * The input of a phone's digest: the E.164 number (a leading "+" or "00", then 7 to 15 digits,
 * the first not 0), with spaces, dots, dashes and brackets removed. A number with no country
 * code cannot be told from another country's and has no digest (null): the contact path dials
 * only E.164 numbers, so the digest it writes is always comparable.
 */
export function customerPhoneDigestInput(phone: unknown): string | null {
  if (typeof phone !== "string" || phone.length > 40) return null;
  const compact = phone.normalize("NFKC").replace(/[\s().-]/gu, "");
  const e164 = compact.startsWith("00") ? "+" + compact.slice(2) : compact;
  return /^\+[1-9][0-9]{6,14}$/.test(e164) ? "morrow.customer-phone.v1|" + e164 : null;
}

const encoder = new TextEncoder();
async function hmacHex(key: CryptoKey, input: string): Promise<string> {
  return vaultBytesHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(input))),
  );
}
/** Imports 32 key bytes as a non-extractable HMAC-SHA-256 key, then zeroes the bytes. */
export async function importCustomerDigestKey(
  version: number,
  bytes: Uint8Array,
): Promise<CustomerDigestKey> {
  try {
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > customerDigestKeyVersionsMax ||
      !(bytes instanceof Uint8Array) ||
      bytes.length !== vaultLimits.keyBytes
    )
      throw new VaultError("VAULT_RECORD_INVALID");
    const raw = new Uint8Array(bytes);
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        raw,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return Object.freeze({ version, key });
    } finally {
      raw.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}
/**
 * The digests of one Shopify customer object ({id, email, phone}, as a compliance payload names
 * it) under every given key version, ascending. Nothing else of the object is read.
 */
export async function customerDigests(
  keys: readonly CustomerDigestKey[],
  customer: unknown,
): Promise<readonly CustomerDigestSet[]> {
  const field = (name: string): unknown =>
    customer !== null && typeof customer === "object" && Object.hasOwn(customer, name)
      ? (customer as Record<string, unknown>)[name]
      : undefined;
  const inputs = {
    id: customerIdDigestInput(field("id")),
    email: customerEmailDigestInput(field("email")),
    phone: customerPhoneDigestInput(field("phone")),
  };
  const sets: CustomerDigestSet[] = [];
  for (const k of [...keys].sort((a, b) => a.version - b.version)) {
    const one = async (input: string | null) => (input === null ? null : hmacHex(k.key, input));
    sets.push(
      Object.freeze({
        version: k.version,
        id: await one(inputs.id),
        email: await one(inputs.email),
        phone: await one(inputs.phone),
      }),
    );
  }
  return Object.freeze(sets);
}

// ---------------------------------------------------------------------------------------------
// The vault: the keys of the workspace an app invites (the tenant every delivery of that app is
// recorded under), read in the broker's verifying transaction. The first compliance request of
// a workspace creates version 1: 32 random bytes sealed under the broker's KEK, bound to the
// tenant and version (vault.ts additional data); a racing second creation keeps the first.
const keyColumns =
  "kek_version,organization_id,outcome,sealed_value,version,workspace_id,wrapped_key";
type KeyRow = Readonly<Record<string, unknown>>;
const recordId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
async function readKeyRows(
  query: VaultQuery,
  appKey: string,
  shop: string,
): Promise<readonly KeyRow[]> {
  const rows = await query(vaultStatements.customerDigestKeysGet, [appKey, shop]);
  if (
    !Array.isArray(rows) ||
    rows.length < 1 ||
    rows.length > customerDigestKeyVersionsMax ||
    rows.some((r) => Object.keys(r).sort().join(",") !== keyColumns)
  )
    throw new VaultError("VAULT_RECORD_INVALID");
  return rows;
}
/**
 * Every kept version of the digest key of the workspace that app `appKey` (registered for
 * `shop`) invites, opened, ascending; version 1 is created first if the workspace has none.
 * Null when no app is registered for that shop. Any other outcome, a malformed row or a failed
 * open is a VaultError (the delivery is then not recorded, and Shopify retries it).
 */
export async function workspaceCustomerDigestKeys(
  keyring: VaultKeyring,
  query: VaultQuery,
  appKey: string,
  shop: string,
): Promise<readonly CustomerDigestKey[] | null> {
  let rows = await readKeyRows(query, appKey, shop);
  if (rows.length === 1 && rows[0]!.outcome === "not_found") return null;
  if (rows.length === 1 && rows[0]!.outcome === "none") {
    const { organization_id: org, workspace_id: ws } = rows[0]!;
    if (
      typeof org !== "string" ||
      !recordId.test(org) ||
      typeof ws !== "string" ||
      !recordId.test(ws)
    )
      throw new VaultError("VAULT_RECORD_INVALID");
    const material = new Uint8Array(vaultLimits.keyBytes);
    crypto.getRandomValues(material);
    let sealed;
    try {
      sealed = await sealVaultRecord(
        keyring,
        {
          kind: "customer_digest_key",
          organizationId: org,
          workspaceId: ws,
          provider: "morrow",
          version: 1,
        },
        material,
      );
    } finally {
      material.fill(0);
    }
    const created = await query(vaultStatements.customerDigestKeyCreate, [
      appKey,
      shop,
      String(sealed.kekVersion),
      vaultBytesHex(sealed.wrappedKey),
      vaultBytesHex(sealed.sealedValue),
    ]);
    if (
      !Array.isArray(created) ||
      created.length !== 1 ||
      !["created", "exists"].includes(created[0]!.outcome as string)
    )
      throw new VaultError("VAULT_RECORD_INVALID");
    rows = await readKeyRows(query, appKey, shop);
  }
  const keys: CustomerDigestKey[] = [];
  let previous = 0;
  for (const r of rows) {
    if (
      r.outcome !== "found" ||
      typeof r.organization_id !== "string" ||
      typeof r.workspace_id !== "string" ||
      r.organization_id !== rows[0]!.organization_id ||
      r.workspace_id !== rows[0]!.workspace_id ||
      typeof r.version !== "string" ||
      !/^[1-8]$/.test(r.version) ||
      Number(r.version) <= previous ||
      typeof r.kek_version !== "string" ||
      !/^[1-9][0-9]{0,2}$/.test(r.kek_version)
    )
      throw new VaultError("VAULT_RECORD_INVALID");
    previous = Number(r.version);
    const opened = await openVaultRecord(
      keyring,
      {
        kind: "customer_digest_key",
        organizationId: r.organization_id,
        workspaceId: r.workspace_id,
        provider: "morrow",
        version: previous,
      },
      {
        kekVersion: Number(r.kek_version),
        wrappedKey: vaultHexBytes(
          r.wrapped_key,
          vaultLimits.wrappedKeyBytes,
          vaultLimits.wrappedKeyBytes,
        ),
        sealedValue: vaultHexBytes(
          r.sealed_value,
          vaultLimits.ivBytes + vaultLimits.keyBytes + vaultLimits.tagBytes,
          vaultLimits.ivBytes + vaultLimits.keyBytes + vaultLimits.tagBytes,
        ),
      },
    );
    keys.push(await importCustomerDigestKey(previous, opened));
  }
  return Object.freeze(keys);
}
