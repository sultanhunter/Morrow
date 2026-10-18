import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";

// Additive request primitives (P06.T01a §4.9) shared by the P05 standalone guard
// and the P06 work guard, so both derive the session digest identically. Pure:
// no SQL, pool, provider or configuration. The digest is bearer-equivalent; only
// the immediately executing handler may hold it, and it is never logged.

/** A canonical base64url 32-byte browser session secret (43 characters). */
export function canonicalSessionSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}

/**
 * The single `__Host-morrow_session` secret of a Cookie header, or null when the
 * header is absent, oversized, non-printable, has more than 32 pairs or a
 * malformed pair, or carries zero, two or a non-canonical session cookie.
 */
export function sessionCookieSecret(header: string | null): string | null {
  if (!header || header.length > 4096 || /[^\x20-\x7e]/.test(header)) return null;
  const pairs = header.split(";");
  if (pairs.length > 32) return null;
  let secret: string | undefined;
  for (const pair of pairs) {
    const match =
      /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/.exec(
        pair.trim(),
      );
    if (!match) return null;
    if (match[1] === "__Host-morrow_session") {
      if (secret !== undefined || !canonicalSessionSecret(match[2])) return null;
      secret = match[2];
    }
  }
  return secret ?? null;
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 (lowercase hex) of the session secret's UTF-8 bytes: the stored session digest. */
export async function sessionSecretDigest(secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(secret);
  try {
    return hex(await crypto.subtle.digest("SHA-256", bytes));
  } finally {
    bytes.fill(0);
  }
}

/** The session digest of a Cookie header, or null exactly when sessionCookieSecret is null. */
export async function sessionCookieDigest(header: string | null): Promise<string | null> {
  const secret = sessionCookieSecret(header);
  return secret === null ? null : sessionSecretDigest(secret);
}

/** Strict JSON text: duplicate member names and lone surrogates are rejected. */
export const parseStrictJson: (value: unknown, maxBytes: number) => unknown =
  parseWorkosSessionStatusJson;
