/** Contract types and the one contract version, both generated from scripts/contract-sources.mjs. */
import { contractVersion } from "./generated/domain";
export { contractVersion };
export type ScaffoldHealth = {
  service: "api" | "workers";
  contracts: typeof contractVersion;
  mode: "scaffold";
};
export type * from "./generated/domain";
// The closed IANA time zone list (ADR-0043 item 8): shops, schedules and the Owner's override.
export {
  canonicalTimeZone,
  ianaTimeZoneAliases,
  ianaTimeZoneData,
  ianaTimeZones,
  isIanaTimeZone,
} from "./time-zones";
