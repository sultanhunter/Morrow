// shopifyConnectionCheck (v1 PR 5; ADR-0025 item 10; ADR-0022 items 4 and 7): the read-back of
// one live store installation's granted scopes with its own offline token. Trust model v1:
// the connector names only the installation and a budget; the broker resolves everything
// else from the database and decides.
//   1. Closed inputs: an installation id and a budget within shopifyLimits.budgetMaxMs.
//   2. One vault transaction, alone (never held across the Shopify call; the vault login's
//      CONNECTION LIMIT 10 is shared with ingress, reads and Stripe):
//      morrow_vault.shopify_check_resolve returns the installation's tenant, shop domain and
//      active credential's envelope, only while it is unlinked or linked, not redacted, and
//      its app is active. Anything else is not_applicable, and nothing is sent.
//   3. The token is opened with the KEK (the envelope's additional data binds the tenant,
//      the credential, the store installation as its subject and the version), used for one
//      fixed document (AccessScopes) and its bytes dropped. A 401 is token_refused; a
//      well-formed answer is the scopes; anything else is unavailable and records nothing.
//   4. One vault transaction records what Shopify answered
//      (morrow_vault.shopify_check_record), for the token version that was read and the
//      installation's revision the resolution found: a newer token (a re-authorisation
//      meanwhile) or any change since (a scopes_update delivery's narrowing in between)
//      makes it stale, and nothing is recorded: an answer read before a narrowing never
//      undoes it (PR 5 review finding F2); the cron asks again. A lost
//      COMMIT acknowledgement is unavailable: the record is idempotent and the cron asks
//      again; nothing is assumed either way.
// The connector then reconciles the stops and the Reconnect item from the recorded state
// (morrow_work.connector_health_reconcile). Nothing here logs; the token, the envelope and
// Shopify's reply never cross the binding.
import {
  encodeShopifyConnectionCheck,
  shopifyInstallationIdPattern,
  shopifyLimits,
  shopifyShopPattern,
  type ShopifyConnectionCheckOutcome,
} from "../../../packages/identity/src/broker-protocol.js";
import { BrokerHold, brokerCapabilities, invokeBrokerMethod } from "./capabilities.js";
import type { VaultTransaction } from "./shopify-install.js";
import { readShopifyAccessScopes, type ShopifyFetch } from "./shopify.js";
import { runVaultTransaction } from "./vault-database.js";
import {
  VaultError,
  openVaultRecord,
  vaultHexBytes,
  vaultLimits,
  vaultStatements,
} from "./vault.js";

export interface ShopifyHealthDependencies {
  readonly transaction: VaultTransaction;
  readonly fetch: ShopifyFetch;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Each vault step gets at most this much of the budget; the rest is Shopify's.
const stepBudgetMs = 3000;
// The record's reserve: the Shopify call ends this long before the deadline.
const recordReserveMs = 1500;
/** Read-backs on the vault login at once per broker isolate (one cron run at a time). */
export const shopifyHealthSlots = 1;
const resolveColumns = [
  "outcome",
  "organization_id",
  "workspace_id",
  "shop_domain",
  "credential_id",
  "credential_version",
  "revision",
  "kek_version",
  "wrapped_key",
  "sealed_value",
] as const;
const checkRecordOutcomes = [
  "applied",
  "unchanged",
  "stale",
  "ineligible",
  "not_found",
  "invalid",
  "denied",
] as const;

export function createShopifyHealthChecker(deps: Readonly<ShopifyHealthDependencies>) {
  let checking = 0;
  async function check(env: unknown, installationId: unknown, budgetMs: unknown): Promise<string> {
    // 1. Closed inputs.
    if (!exact(shopifyInstallationIdPattern, installationId)) throw new BrokerHold("INPUT_INVALID");
    if (
      typeof budgetMs !== "number" ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < 1 ||
      budgetMs > shopifyLimits.budgetMaxMs
    )
      throw new BrokerHold("BUDGET_INVALID");
    const deadline = deps.now() + budgetMs;
    const answer = (outcome: ShopifyConnectionCheckOutcome) =>
      encodeShopifyConnectionCheck(outcome);
    const capabilities = await brokerCapabilities(env);
    const vault = capabilities.vault;
    if (!vault) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
    if (checking >= shopifyHealthSlots) throw new BrokerHold("READ_BUSY");
    checking++;
    try {
      // 2. The resolution, alone in its transaction.
      let r: Record<string, unknown>;
      try {
        r = await deps.transaction(
          vault,
          Math.max(1, Math.min(stepBudgetMs, deadline - deps.now())),
          async (query) => {
            const rows = await query(vaultStatements.shopifyCheckResolve, [installationId]);
            const row = rows.length === 1 ? rows[0]! : undefined;
            if (!row || Object.keys(row).sort().join(",") !== [...resolveColumns].sort().join(","))
              throw new VaultError("VAULT_RECORD_INVALID");
            return row;
          },
        );
      } catch (error) {
        if (error instanceof VaultError && error.code === "VAULT_OUTCOME_UNKNOWN")
          return answer("unavailable");
        throw error;
      }
      if (r.outcome !== "resolved") return answer("not_applicable");
      const { organization_id: org, workspace_id: ws, credential_id: credential } = r;
      const shop = r.shop_domain;
      if (
        !exact(idPattern, org) ||
        !exact(idPattern, ws) ||
        !exact(idPattern, credential) ||
        !exact(shopifyShopPattern, shop) ||
        !exact(/^[1-9][0-9]{0,15}$/, r.credential_version) ||
        !exact(/^[1-9][0-9]{0,15}$/, r.revision) ||
        !exact(/^[1-9][0-9]{0,2}$/, r.kek_version) ||
        typeof r.wrapped_key !== "string" ||
        typeof r.sealed_value !== "string"
      )
        throw new VaultError("VAULT_RECORD_INVALID");
      // 3. The token, for one fixed document.
      const plaintext = await openVaultRecord(
        vault.keyring,
        {
          kind: "shopify_offline_token",
          organizationId: org,
          workspaceId: ws,
          credentialId: credential,
          subjectId: installationId,
          provider: "shopify",
          version: Number(r.credential_version),
        },
        {
          kekVersion: Number(r.kek_version),
          wrappedKey: vaultHexBytes(
            r.wrapped_key,
            vaultLimits.wrappedKeyBytes,
            vaultLimits.wrappedKeyBytes,
          ),
          sealedValue: vaultHexBytes(
            r.sealed_value,
            vaultLimits.sealedMinBytes,
            vaultLimits.sealedMaxBytes,
          ),
        },
      );
      let token: string;
      try {
        token = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
      } catch {
        throw new VaultError("VAULT_OPEN_FAILED");
      } finally {
        plaintext.fill(0);
      }
      if (deadline - recordReserveMs - deps.now() <= 0) return answer("unavailable");
      const scopes = await readShopifyAccessScopes(
        deps.fetch,
        shop,
        token,
        deadline - recordReserveMs,
        deps.now,
        deps.sleep,
      );
      token = "";
      if (scopes.kind === "unavailable") return answer("unavailable");
      // 4. The record, for the token version that was read.
      let recorded: string;
      try {
        recorded = await deps.transaction(
          vault,
          Math.max(1, Math.min(stepBudgetMs, deadline - deps.now())),
          async (query) => {
            const rows = await query(vaultStatements.shopifyCheckRecord, [
              installationId,
              r.credential_version as string,
              r.revision as string,
              scopes.kind === "scopes" ? "observed" : "refused",
              scopes.kind === "scopes" ? JSON.stringify(scopes.scopes) : "",
            ]);
            const row = rows.length === 1 ? rows[0]! : undefined;
            if (
              !row ||
              Object.keys(row).join(",") !== "outcome" ||
              !(checkRecordOutcomes as readonly unknown[]).includes(row.outcome)
            )
              throw new VaultError("VAULT_RECORD_INVALID");
            return row.outcome as string;
          },
        );
      } catch (error) {
        if (error instanceof VaultError && error.code === "VAULT_OUTCOME_UNKNOWN")
          return answer("unavailable");
        throw error;
      }
      if (recorded === "applied" || recorded === "unchanged")
        return answer(scopes.kind === "scopes" ? "observed" : "token_refused");
      if (recorded === "stale") return answer("stale");
      return answer("not_applicable");
    } finally {
      checking--;
    }
  }
  return Object.freeze({ check });
}

const live = createShopifyHealthChecker({
  transaction: (vault, budgetMs, body) => runVaultTransaction(vault, budgetMs, body),
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
});
export function brokerShopifyConnectionCheck(
  env: unknown,
  installationId: unknown,
  budgetMs: unknown,
) {
  return invokeBrokerMethod(
    "shopifyConnectionCheck",
    () => live.check(env, installationId, budgetMs),
    "ConnectorBroker",
  );
}
