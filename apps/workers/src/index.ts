import { contractVersion, type ScaffoldHealth } from "@morrow/contracts";
const health: ScaffoldHealth = { service: "workers", contracts: contractVersion, mode: "scaffold" };
console.log(JSON.stringify(health));
// P06/P12 wire durable workers; this executable intentionally dispatches nothing.
