// shopifyRead (M2 PR-3; spine §4; ADR-0022 items 4 and 7; ADR-0008 item 1 as amended): one
// fixed Admin GraphQL document under a live lease. Trust model v1: the caller names only the
// lease, its generation, its subject (the read's request id, or the run id), the query and
// closed variables; the broker resolves everything else from the database.
//   1. Closed inputs: the query must be one this entrypoint serves (ApiBroker: the shop
//      identity and the collection and product pages under a read lease; RuntimeBroker: one
//      product's listing fields under a run lease), with its closed variables.
//   2. One vault transaction, alone (review finding B1: never held across the Shopify call;
//      the vault login's CONNECTION LIMIT 10 is shared with ingress and Stripe), and at most
//      shopifyReadSlots of them at once per isolate (M2 PR-3 review: the catalogue routes
//      are signed-in but not rate limited, so a member's burst of reads could otherwise hold
//      every connection that webhook recording, install stores, credential destructions and
//      Stripe receipts need; one more is held, READ_BUSY, before any transaction; ingress
//      keeps its own three slots, apps/broker/src/shopify-install.ts):
//      morrow_vault.shopify_read_resolve runs resolve_call with the subject the caller names
//      (lease active, of this generation, unexpired, its member current, no stop, the store's
//      connection current), fits the query to the lease kind (and a run lease to its run's
//      products), and returns the store installation that is the active credential's
//      subject, its shop domain and the token's envelope. Any refusal is READ_REFUSED.
//   3. The token is opened with the KEK (the envelope's additional data binds the tenant,
//      the credential, the store installation as its subject and the version), used for
//      one fixed document and its zeroed bytes dropped. THROTTLED waits once within the
//      budget; any other error, status or shape is READ_REFUSED. A 401 changes nothing: the
//      app/uninstalled webhook is the state change.
//   4. The reply is minimised to the protocol's closed JSON (ids, titles, a product's status
//      and its listing fields) and checked with the protocol's own decoder before it leaves.
// Plan row SD5 (the query-cost switch, MORROW_SHOPIFY_QUERY_COST, committed off): while it is
// on, step 2's transaction also takes the document's known query cost from the installation's
// bucket (morrow_vault.shopify_query_cost_take, after a resolved resolution only), a person
// read (ApiBroker) in the person_read class and an agent read (RuntimeBroker) in agent_read.
// A read the bucket cannot yet cover waits in the broker while the wait is short and fits the
// budget, and otherwise is not sent and answers `parked` with retryAfterMs (an agent read
// parks; H7b's run.wait consumes it). The document is sent once with no in-call wait, and
// Shopify's cost report settles the bucket (shopify_query_cost_settle, in its own
// transaction, within the same slots); a THROTTLED reply refunds the charge and takes again
// from the corrected bucket. The token is opened only when the document is first sent.
// Nothing here logs; the token, the envelope and Shopify's reply never cross the binding.
import {
  decodeShopifyReadResult,
  parseShopifyReadVariables,
  shopifyReadLimits,
  shopifyReadQueries,
  shopifyShopPattern,
  type ShopifyReadQuery,
  type ShopifyReadVariables,
} from "../../../packages/identity/src/broker-protocol.js";
import { BrokerHold, brokerCapabilities, invokeBrokerMethod } from "./capabilities.js";
import type { VaultTransaction } from "./shopify-install.js";
import {
  bucketedShopifyCall,
  takeShopifyQueryCost,
  type QueryCostTake,
} from "./shopify-query-cost.js";
import {
  shopifyAdminGraphql,
  shopifyAdminGraphqlOnce,
  shopifyReadCosts,
  shopifyReadDocuments,
  shopifyReadPageSize,
  shopifyReadResult,
  type ShopifyAdminReply,
  type ShopifyFetch,
} from "./shopify.js";
import { runVaultTransaction } from "./vault-database.js";
import {
  VaultError,
  openVaultRecord,
  vaultHexBytes,
  vaultLimits,
  vaultStatements,
  type VaultQuery,
} from "./vault.js";

export interface ShopifyReadDependencies {
  readonly transaction: VaultTransaction;
  readonly fetch: ShopifyFetch;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}
export type ShopifyReadCaller = keyof typeof shopifyReadQueries;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
const leasePattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// The resolution gets at most this much of the budget; the rest is Shopify's.
const resolveBudgetMs = 3000;
/** Read resolutions on the vault login at once per broker isolate (step 2). */
export const shopifyReadSlots = 2;
const resolveColumns = [
  "outcome",
  "organization_id",
  "workspace_id",
  "lease_kind",
  "store_id",
  "connection_id",
  "installation_id",
  "shop_domain",
  "credential_id",
  "credential_version",
  "kek_version",
  "wrapped_key",
  "sealed_value",
] as const;
const refused = () => new BrokerHold("READ_REFUSED");

// The fixed document of one query and its GraphQL variables (built here, never taken from
// the caller): a products page with a collection reads that collection's products; a title
// search uses Shopify's search syntax over letters and digits only.
function documentFor(v: ShopifyReadVariables) {
  const first = shopifyReadPageSize;
  switch (v.query) {
    case "shopIdentity":
      return { name: "shopIdentity" as const, variables: {} };
    case "collectionsPage":
      return { name: "collectionsPage" as const, variables: { first, after: v.after } };
    case "productsPage":
      return v.collectionId !== null
        ? {
            name: "collectionProductsPage" as const,
            variables: {
              id: "gid://shopify/Collection/" + v.collectionId.slice("collection:".length),
              first,
              after: v.after,
            },
          }
        : {
            name: "productsPage" as const,
            variables: {
              first,
              after: v.after,
              query:
                v.search === null
                  ? null
                  : v.search
                      .split(" ")
                      .map((word) => `title:${word}*`)
                      .join(" AND "),
            },
          };
    case "productContent":
      return {
        name: "productContent" as const,
        variables: { id: "gid://shopify/Product/" + v.productId.slice("product:".length) },
      };
  }
}

export function createShopifyReader(deps: Readonly<ShopifyReadDependencies>) {
  // Step 2's slots: one counter per reader, which is one per isolate for the live broker.
  // Only the resolution's transaction is counted; the Shopify call holds no connection.
  let resolving = 0;
  async function resolution<T>(run: () => Promise<T>): Promise<T> {
    if (resolving >= shopifyReadSlots) throw new BrokerHold("READ_BUSY");
    resolving++;
    try {
      return await run();
    } finally {
      resolving--;
    }
  }
  async function read(
    env: unknown,
    caller: ShopifyReadCaller,
    leaseId: unknown,
    generation: unknown,
    subjectId: unknown,
    queryName: unknown,
    variablesJson: unknown,
    budgetMs: unknown,
  ): Promise<string> {
    // 1. Closed inputs.
    if (
      !exact(leasePattern, leaseId) ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !exact(idPattern, subjectId) ||
      typeof queryName !== "string" ||
      !(shopifyReadQueries[caller] as readonly string[]).includes(queryName)
    )
      throw new BrokerHold("INPUT_INVALID");
    if (
      typeof budgetMs !== "number" ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < 1 ||
      budgetMs > shopifyReadLimits.budgetMaxMs
    )
      throw new BrokerHold("BUDGET_INVALID");
    const variables = parseShopifyReadVariables(queryName, variablesJson);
    if (!variables) throw new BrokerHold("INPUT_INVALID");
    const deadline = deps.now() + budgetMs;
    const capabilities = await brokerCapabilities(env);
    const vault = capabilities.vault;
    if (!vault) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
    const document = documentFor(variables);
    // SD5: the bucket's class and the document's known cost, while the switch is on.
    const bucket =
      capabilities.shopifyQueryCost === "on"
        ? {
            cls: caller === "api" ? ("person_read" as const) : ("agent_read" as const),
            cost: shopifyReadCosts[document.name],
          }
        : null;
    // One vault transaction within the isolate's read slots and the read's budget (step 2's
    // resolution, and SD5's later takes and settles).
    const transact = <T>(body: (query: VaultQuery) => Promise<T>): Promise<T> =>
      resolution(() =>
        deps.transaction(
          vault,
          Math.max(1, Math.min(resolveBudgetMs, deadline - deps.now())),
          body,
        ),
      );
    // 2. The resolution, alone in its transaction, within the isolate's read slots (with
    // SD5's first take, after a resolved resolution only).
    const productId = variables.query === "productContent" ? variables.productId : "";
    const { row: r, take } = await transact(async (query) => {
      const rows = await query(vaultStatements.shopifyReadResolve, [
        leaseId,
        String(generation),
        subjectId,
        queryName,
        productId,
      ]);
      const row = rows.length === 1 ? rows[0]! : undefined;
      if (!row || Object.keys(row).sort().join(",") !== [...resolveColumns].sort().join(","))
        throw new VaultError("VAULT_RECORD_INVALID");
      const taken: QueryCostTake | null =
        bucket !== null && row.outcome === "resolved" && exact(idPattern, row.installation_id)
          ? await takeShopifyQueryCost(query, row.installation_id, bucket.cls, bucket.cost)
          : null;
      return { row, take: taken };
    });
    if (r.outcome !== "resolved") throw refused();
    const { organization_id: org, workspace_id: ws, credential_id: credential } = r;
    const { installation_id: installation, shop_domain: shop } = r;
    if (
      !exact(idPattern, org) ||
      !exact(idPattern, ws) ||
      !exact(idPattern, credential) ||
      !exact(idPattern, installation) ||
      !exact(shopifyShopPattern, shop) ||
      !exact(/^[1-9][0-9]{0,15}$/, r.credential_version) ||
      !exact(/^[1-9][0-9]{0,2}$/, r.kek_version)
    )
      throw new VaultError("VAULT_RECORD_INVALID");
    // 3. The token, for one fixed document, opened when the document is first sent.
    const openToken = async (): Promise<string> => {
      const plaintext = await openVaultRecord(
        vault.keyring,
        {
          kind: "shopify_offline_token",
          organizationId: org,
          workspaceId: ws,
          credentialId: credential,
          subjectId: installation,
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
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
      } catch {
        throw new VaultError("VAULT_OPEN_FAILED");
      } finally {
        plaintext.fill(0);
      }
    };
    // A resolved read with the switch on always carries its first take (step 2).
    if (bucket !== null && take === null) throw new VaultError("VAULT_RECORD_INVALID");
    let token = "";
    let reply: ShopifyAdminReply;
    try {
      if (bucket === null || take === null) {
        token = await openToken();
        reply = await shopifyAdminGraphql(
          deps.fetch,
          shop,
          token,
          shopifyReadDocuments[document.name],
          document.variables,
          deadline,
          deps.now,
          deps.sleep,
          shopifyReadLimits.resultMaxBytes,
        );
      } else {
        const outcome = await bucketedShopifyCall({
          installationId: installation,
          cls: bucket.cls,
          cost: bucket.cost,
          deadlineMs: deadline,
          now: deps.now,
          sleep: deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
          transact: (body) => transact(body),
          first: take,
          send: async () => {
            if (token === "") token = await openToken();
            const attempt = await shopifyAdminGraphqlOnce(
              deps.fetch,
              shop,
              token,
              shopifyReadDocuments[document.name],
              document.variables,
              deadline,
              deps.now,
              shopifyReadLimits.resultMaxBytes,
            );
            const answered = attempt.kind === "data" || attempt.kind === "throttled";
            return {
              reply: attempt,
              cost: answered ? attempt.cost : null,
              throttled: attempt.kind === "throttled",
              answered,
            };
          },
        });
        if (outcome.kind === "refused") throw refused();
        if (outcome.kind === "parked") {
          // Not sent: the protocol's closed parked result.
          const text = JSON.stringify({
            schemaVersion: 1,
            outcome: "parked",
            retryAfterMs: outcome.retryAfterMs,
          });
          try {
            decodeShopifyReadResult(queryName as ShopifyReadQuery, text);
          } catch {
            throw refused();
          }
          return text;
        }
        const attempt = outcome.reply;
        reply =
          attempt.kind === "data"
            ? Object.freeze({ kind: "data", data: attempt.data })
            : attempt.kind === "throttled"
              ? Object.freeze({ kind: "refused", reason: "throttled" })
              : attempt;
      }
    } finally {
      token = "";
    }
    if (reply.kind !== "data") throw refused();
    // 4. The minimised, closed result.
    const result = shopifyReadResult(document.name, reply.data, shop);
    if (!result) throw refused();
    const text = JSON.stringify(result);
    try {
      decodeShopifyReadResult(queryName as ShopifyReadQuery, text);
    } catch {
      throw refused();
    }
    return text;
  }
  return Object.freeze({ read });
}

const live = createShopifyReader({
  transaction: (vault, budgetMs, body) => runVaultTransaction(vault, budgetMs, body),
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
});
export function brokerShopifyRead(
  env: unknown,
  caller: ShopifyReadCaller,
  leaseId: unknown,
  generation: unknown,
  subjectId: unknown,
  queryName: unknown,
  variablesJson: unknown,
  budgetMs: unknown,
) {
  return invokeBrokerMethod(
    "shopifyRead",
    () =>
      live.read(env, caller, leaseId, generation, subjectId, queryName, variablesJson, budgetMs),
    caller === "api" ? "ApiBroker" : "RuntimeBroker",
  );
}
