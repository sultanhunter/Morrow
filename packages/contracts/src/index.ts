/** Contract types and the one contract version, both generated from scripts/contract-sources.mjs. */
import { contractVersion } from "./generated/domain";
export { contractVersion };
export type ScaffoldHealth = {
  service: "api" | "workers";
  contracts: typeof contractVersion;
  mode: "scaffold";
};
export type * from "./generated/domain";
