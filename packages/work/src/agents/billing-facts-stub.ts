import type { BillingScope } from "@morrow/policy/billing-state";

// BRANCH-LOCAL STUB, never merged as such (integration interface "Billing facts, billing
// period and credit wallet"): M5 PR-1's @morrow/work/billing exports
// createBillingFactsReader(query), which yields the parseWorkspaceBillingFacts input for
// workspaceBillingState and entitlementFor, plus billingPeriod {start, end} | null (the line
// period of the latest verified subscription invoice). Until M5 PR-1 merges there are no
// billing tables to read, so this stub of exactly that interface fails closed: every read
// throws BILLING_FACTS_UNAVAILABLE, so the agent fact reader denies (the kernel's
// AGENT_POLICY_AUTHORITY_UNAVAILABLE) and no run is ever admitted. At rebase this file is
// deleted and the delegation reader imports M5's reader.
export type BillingFactsQuery = (
  text: string,
  values: readonly (string | null)[],
) => Promise<readonly Record<string, unknown>[]>;
export interface BillingPeriod {
  readonly start: string;
  readonly end: string;
}
export interface BillingFactsRead {
  /** The parseWorkspaceBillingFacts input of the workspace. */
  readonly facts: unknown;
  /** The current subscription period, or null (no period means no entitlement). */
  readonly billingPeriod: BillingPeriod | null;
}
export interface BillingFactsReaderPort {
  read(scope: BillingScope): Promise<BillingFactsRead>;
}
export class BillingFactsUnavailable extends Error {
  constructor() {
    super("BILLING_FACTS_UNAVAILABLE");
    this.name = "BillingFactsUnavailable";
  }
}
/** M5 PR-1's reader, stubbed: fails closed on every read. */
export function createBillingFactsReader(query: BillingFactsQuery): BillingFactsReaderPort {
  if (typeof query !== "function") throw new BillingFactsUnavailable();
  return Object.freeze({
    async read(): Promise<BillingFactsRead> {
      throw new BillingFactsUnavailable();
    },
  });
}
