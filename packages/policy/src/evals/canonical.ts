// Canonical JSON (RFC 8785 for the plain JSON the eval files hold: sorted keys, no
// whitespace) and SHA-256 over Web Crypto, so this module loads anywhere (no node:*).
import { evalWorldVersion, type EvalCase } from "./format";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw Error("EVAL_CANONICAL_JSON_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
        .join(",") +
      "}"
    );
  }
  throw Error("EVAL_CANONICAL_JSON_INVALID");
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The digest a recording is bound to: the case's inputs (entry, request, fixtures and world)
 * and the eval world's version. Expectations, probes, titles and the rubric are not inputs, so
 * changing them never makes a recording stale; any other change does.
 */
export async function recordingBasisDigest(evalCase: EvalCase): Promise<string> {
  return sha256Hex(
    canonicalJson({
      worldVersion: evalWorldVersion,
      caseId: evalCase.caseId,
      entry: evalCase.entry,
      agents: evalCase.agents,
      request: evalCase.request,
      fixtures: evalCase.fixtures,
      world: evalCase.world,
    }),
  );
}
