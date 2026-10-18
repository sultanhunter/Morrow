// What is paid work (P01.T04a §1; ADR-0015 item 5, ADR-0011 Q8). Pure: the
// reviewed table and the catalogue are read once at import and frozen; no I/O
// follows. Entitlement gates only paid work, so reads, setup, linking,
// invitations, approvals, exports, privacy and every kill switch never read it.
// `inspectPaidWork` (scripts/billing-checks.mjs, run by `npm run verify:billing`)
// checks the table against rules PW1-PW5. Narrowing the table is a billing
// change and needs an ADR.
import table from "../../../docs/contracts/paid-work.json";
import catalogue from "../../../docs/contracts/capabilities.json";

const capabilityEffects: readonly string[] = Object.freeze([
  "read",
  "internal_write",
  "external_write",
  "spend",
  "communication",
  "control",
  "billable_job",
]);
const permissionVerbs: readonly string[] = Object.freeze([
  "view",
  "propose",
  "approve",
  "execute",
  "delegate",
  "administer",
]);
const members = (value: unknown, allowed: readonly string[]): value is readonly string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  new Set(value).size === value.length &&
  value.every((item) => typeof item === "string" && allowed.includes(item));

/**
 * Rule PW1 of `inspectPaidWork`, checked again at import: a closed object with
 * `schema_version` 1 and ADR ids; `paidEffects` and `neverGatedVerbs` are
 * non-empty arrays of unique, known effects and verbs; `execute` and
 * `administer` are never exempt; `view` and `approve` always are.
 */
export function paidWorkTableValid(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  const adr = t.adr,
    effects = t.paidEffects,
    verbs = t.neverGatedVerbs;
  return (
    Object.keys(t).sort().join(",") === "adr,neverGatedVerbs,paidEffects,schema_version" &&
    t.schema_version === 1 &&
    Array.isArray(adr) &&
    adr.length > 0 &&
    new Set(adr).size === adr.length &&
    adr.every((id) => typeof id === "string" && /^ADR-\d{4}$/.test(id)) &&
    members(effects, capabilityEffects) &&
    members(verbs, permissionVerbs) &&
    !verbs.some((verb) => verb === "execute" || verb === "administer") &&
    verbs.includes("view") &&
    verbs.includes("approve")
  );
}

// Fail closed at import: a malformed table, or one that would exempt execute or
// administer, never loads, so a typo cannot silently stop gating paid work.
if (!paidWorkTableValid(table)) throw new Error("PAID_WORK_TABLE_INVALID");
const paidEffects: ReadonlySet<string> = new Set(table.paidEffects);
const neverGatedVerbs: ReadonlySet<string> = new Set(table.neverGatedVerbs);
const capabilities: ReadonlyMap<string, { readonly effect: string; readonly killSwitch: boolean }> =
  new Map(
    catalogue.capabilities.map((c) => [
      c.id,
      Object.freeze({ effect: c.effect, killSwitch: c.kill_switch === true }),
    ]),
  );

/**
 * True when `verb` on `capabilityId` is paid work: the capability is unknown
 * (fail closed), or its effect is a paid effect, it is not a kill switch (the
 * catalogue's `kill_switch`, never a table toggle) and the verb is not one of
 * the never-gated verbs. `execute` and `administer` are always gated on a paid
 * capability; `administer` covers transitions of another member's paid record.
 */
export function isPaidWork(capabilityId: string, verb: string): boolean {
  const capability = typeof capabilityId === "string" ? capabilities.get(capabilityId) : undefined;
  if (!capability) return true;
  if (capability.killSwitch) return false;
  return paidEffects.has(capability.effect) && !neverGatedVerbs.has(verb);
}

/** The catalogue capabilities whose `execute` is paid work, sorted (27 in contract v1.1). */
export const paidWorkCapabilityIds: readonly string[] = Object.freeze(
  catalogue.capabilities
    .map((c) => c.id)
    .filter((id) => isPaidWork(id, "execute"))
    .sort(),
);
