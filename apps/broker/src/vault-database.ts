// BRANCH-LOCAL STUB (M5 PR-1). OWNED BY M2 PR-2: this file is replaced by M2 PR-2's
// apps/broker/src/vault-database.ts at the final rebase and is never merged as is
// (integration.json cross_pr_interfaces, "Broker vault-login transport").
//
// It keeps exactly the interface M2 fixes:
//   runVaultTransaction<T>(vault: BrokerVault, budgetMs: number,
//     body: (query: VaultQuery) => Promise<T>): Promise<T>
// with the frozen vaultStatements registry and VaultQuery in vault.ts, text values only,
// fixed VaultError codes, and VAULT_OUTCOME_UNKNOWN for a COMMIT whose acknowledgement was
// lost. The stub opens no connection (the broker's Neon-driver allowance stays with M2):
// every call fails closed with VAULT_DATABASE_UNAVAILABLE, so in this branch the deployed
// broker's Stripe methods answer BROKER_HELD and billing answers 503. Unit tests and
// lab:billing drive apps/broker/src/stripe.ts with a transport of this exact signature.
import type { BrokerVault } from "./capabilities.js";
import { VaultError, type VaultQuery } from "./vault.js";

export function runVaultTransaction<T>(
  vault: Readonly<BrokerVault>,
  budgetMs: number,
  body: (query: VaultQuery) => Promise<T>,
): Promise<T> {
  void vault;
  void budgetMs;
  void body;
  return Promise.reject(new VaultError("VAULT_DATABASE_UNAVAILABLE"));
}
