import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";
import { LoginInputError, loginJson, type LoginAttempt } from "./standalone-login-protocol.js";

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

// Session cookie primitives (P05.T01y, ADR-0004). One cookie name, one profile.

/**
 * The exact logout clear. A fixed-name clear also drops a newer cookie of the same name
 * in that browser: a delayed logout from an old tab ends only its own family on the
 * server, but signs the browser out of a newer family too (documented limitation).
 */
export const SESSION_COOKIE_CLEAR =
  "__Host-morrow_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";

/**
 * The session cookie for a generation with `idleRemainingMs` left:
 * Max-Age = min(1800, floor(idleRemainingMs / 1000)); null when under one second or invalid.
 */
export function sessionCookie(secret: string, idleRemainingMs: number): string | null {
  if (!canonicalSessionSecret(secret) || !Number.isSafeInteger(idleRemainingMs)) return null;
  const age = Math.min(1800, Math.floor(idleRemainingMs / 1000));
  if (age < 1) return null;
  return `__Host-morrow_session=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
}

/**
 * Same-origin browser proof for a session mutation (logout, rotate): the exact Origin,
 * JSON, X-Morrow-Request: 1, no Idempotency-Key, and Fetch Metadata same-origin or absent.
 * Throws LoginInputError(403) otherwise.
 */
export function assertSessionBrowserProof(request: Request, origin: string): void {
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("content-type") !== "application/json" ||
    request.headers.get("x-morrow-request") !== "1" ||
    request.headers.has("idempotency-key")
  )
    throw new LoginInputError(403);
  const site = request.headers.get("sec-fetch-site"),
    mode = request.headers.get("sec-fetch-mode"),
    dest = request.headers.get("sec-fetch-dest");
  if (
    (site !== null && site !== "same-origin") ||
    (mode !== null && mode !== "cors" && mode !== "same-origin") ||
    (dest !== null && dest !== "empty")
  )
    throw new LoginInputError(403);
}

/**
 * Reads the body under the attempt: at most 256 bytes of exactly {"schemaVersion":1}.
 * Throws LoginInputError(400) otherwise.
 */
export async function readSchemaVersionBody(
  request: Request,
  attempt: Pick<LoginAttempt, "wait">,
): Promise<void> {
  const length = request.headers.get("content-length"),
    encoding = request.headers.get("transfer-encoding");
  if (
    (length !== null && (!/^(0|[1-9][0-9]{0,2})$/.test(length) || Number(length) > 256)) ||
    (encoding !== null && (encoding !== "chunked" || length !== null))
  )
    throw new LoginInputError(400);
  const reader = request.body?.getReader();
  if (!reader) throw new LoginInputError(400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await attempt.wait(reader.read());
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 256) throw new LoginInputError(400);
      chunks.push(new Uint8Array(next.value));
    }
    if (length !== null && Number(length) !== bytes) throw new LoginInputError(400);
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    let value: Readonly<Record<string, unknown>>;
    try {
      value = loginJson(new TextDecoder("utf-8", { fatal: true }).decode(all), 256, [
        "schemaVersion",
      ]);
    } catch {
      throw new LoginInputError(400);
    }
    if (value.schemaVersion !== 1) throw new LoginInputError(400);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
