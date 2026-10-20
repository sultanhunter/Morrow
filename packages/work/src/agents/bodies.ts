import { validateCapabilityInput, validateCurrentDefinition } from "@morrow/contracts/validation";

// Closed request bodies of the agents routes (M3 PR-1). Each parser returns a fresh plain
// object or null. Tenant, store, installation and actor values are never body fields: the
// store comes from the path and is resolved against its current association; the rest is
// server-derived.
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !own.every((key) => keys.includes(key))) return null;
  return value as Record<string, unknown>;
}
const hex64 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** POST .../agents/listings/document: an empty object (the server derives everything). */
export function parseDocumentBody(body: unknown): Record<string, never> | null {
  return record(body, []) ? {} : null;
}
export interface EnableBody {
  readonly documentDigest: string;
  readonly nonce: string;
}
/** POST .../agents/listings: the confirmed document's digest and its single-use nonce. */
export function parseEnableBody(body: unknown): EnableBody | null {
  const r = record(body, ["documentDigest", "nonce"]);
  if (!r || !hex64(r.documentDigest) || !hex64(r.nonce)) return null;
  return { documentDigest: r.documentDigest, nonce: r.nonce };
}
export interface StopBody {
  readonly control: { readonly reason: string; readonly sourceProposalRef: null };
}
/**
 * POST .../agents/listings/stop: a KillSwitchControl whose reason a person wrote. The MVP
 * has no agent proposal path, so sourceProposalRef is null.
 */
export function parseStopBody(body: unknown): StopBody | null {
  const r = record(body, ["control"]);
  if (!r || !validateCurrentDefinition("KillSwitchControl", r.control)) return null;
  const control = r.control as { reason: string; sourceProposalRef: unknown };
  if (control.sourceProposalRef !== null) return null;
  return { control: { reason: control.reason, sourceProposalRef: null } };
}
export interface ModelDefaultBody {
  readonly model: string;
  readonly effort: string;
  readonly maxCreditsPerProduct: number;
  readonly expectedRevision: number | null;
}
/** PUT /settings/model-default: governance.model_default.revise's v1.1 input body. */
export function parseModelDefaultBody(body: unknown): ModelDefaultBody | null {
  if (!validateCapabilityInput("governance.model_default.revise", body)) return null;
  const r = body as unknown as ModelDefaultBody;
  return {
    model: r.model,
    effort: r.effort,
    maxCreditsPerProduct: r.maxCreditsPerProduct,
    expectedRevision: r.expectedRevision,
  };
}
