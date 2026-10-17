/** P03 shell metadata only; generated domain boundaries follow in P03.T02. */
export const contractVersion = "morrow.contracts.v1" as const;
export type ScaffoldHealth = {
  service: "api" | "workers";
  contracts: typeof contractVersion;
  mode: "scaffold";
};
export type * from "./generated/domain";
