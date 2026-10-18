// What is paid work (P01.T04a §1; ADR-0015 item 5, ADR-0011 Q8). Pure: the
// reviewed table and the catalogue are read once at import and frozen; no I/O
// follows. Entitlement gates only paid work, so reads, setup, linking,
// invitations, approvals, exports, privacy and every kill switch never read it.
// `inspectPaidWork` (scripts/billing-checks.mjs, run by `npm run verify:billing`)
// checks the table against rules PW1-PW5. Narrowing the table is a billing
// change and needs an ADR.
import table from "../../../docs/contracts/paid-work.json";
import catalogue from "../../../docs/contracts/capabilities.json";

// Fail closed at import: a table that is not closed, or that would exempt
// execute or administer, never loads.
if (
  Object.keys(table).sort().join(",") !== "adr,neverGatedVerbs,paidEffects,schema_version" ||
  table.schema_version !== 1 ||
  (table.neverGatedVerbs as readonly string[]).some((verb) =>
    ["execute", "administer"].includes(verb),
  )
)
  throw new Error("PAID_WORK_TABLE_INVALID");
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
