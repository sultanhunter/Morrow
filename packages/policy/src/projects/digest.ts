// The project flow's digests (ADR-0033 item 5, ADR-0034 items 3 and 5): sha256 hex over the
// UTF-8 bytes of a canonical JSON text. Web Crypto only, so the same code runs in Node and in
// the api Worker (workerd has no node:crypto in its typecheck graph). The definers store the
// canonical text and hash it again in SQL (sha256 over the same UTF-8 bytes), so TS and SQL
// agree; tests/projects-digests.test.mjs pins known vectors.

/**
 * Canonical JSON (RFC 8785 over the closed JSON these records hold): object keys sorted by
 * UTF-16 code unit, no whitespace, strings and numbers as JSON.stringify writes them.
 */
export const canonicalText = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? "[" + v.map(canonicalText).join(",") + "]"
      : "{" +
        Object.keys(v as object)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonicalText((v as Record<string, unknown>)[k]))
          .join(",") +
        "}";

/** Lowercase hex sha256 of the text's UTF-8 bytes. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
