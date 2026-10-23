// The gateway's Shopify write and read-back (v1 PR 3; spine §8; ADR-0022 items 4, 7 and 9;
// ADR-0008 item 1 as amended: hand-written fetch, no Shopify library). Trust model v1: the
// api names one catalog_write operation and a budget; everything else comes from the database
// through the vault login's catalog definers (migration catalog-apply).
//
// shopifyProductApply, at most once per operation:
//   0. The apply switch (MORROW_SHOPIFY_WRITE "on", with the vault) before anything else; off
//      is WRITE_UNAVAILABLE. Closed inputs; one write at a time per isolate (WRITE_BUSY).
//   1. T1 catalog_write_resolve, alone in its transaction: the operation must be dispatching
//      and unfenced, within its dispatch window, its lease live, no stop, the installation and
//      the store's link current, write_products granted, the credential active, the claimed
//      parameters unredacted. A durable refusal is recorded there (failed, nothing sent).
//   2. The claimed item's canonical text must hash to the operation's request digest: the
//      write carries exactly the approved item and nothing else.
//   3. The token is opened with the KEK and read once (ProductWriteState): Shopify's current
//      listing fields and updatedAt. A read that fails for a transient reason is `held`:
//      nothing was fenced or sent, and the operation is unchanged.
//   4. T2 catalog_write_begin: under the stop interlock, the product lock and the row lock,
//      every T1 condition again; a product that is gone, a 401, another open write on the
//      product, or current fields whose digest is not the draft's expectedSourceRevision
//      (changed since the draft) close the operation as failed with nothing sent. Otherwise
//      the send fence and its record commit before any request.
//   5. One productUpdate with only the approved keys (tags as the full approved list, both
//      SEO fields together). A THROTTLED reply proves nothing ran: one wait and one resend
//      inside the same fence. Every other reply is classified (classifyProductUpdate): a reply
//      that proves nothing ran is failed; userErrors are failed (Shopify applied nothing);
//      anything that does not prove the outcome is uncertain.
//   6. T3 catalog_write_end records it. A lost T3 leaves the fence open: the read-back marks
//      it uncertain (unknown_submission). Nothing here is ever sent twice.
// shopifyProductReconcile: R1 catalog_reconcile_resolve (keyed by the operation; no lease; never
// blocked by a stop or the switch), one ProductWriteState read, the per-field comparison
// (listing-compare.ts) and R2 catalog_reconcile_record, which alone decides the status.
// Nothing here logs; the token, the envelope and Shopify's replies never cross the binding.
import {
  encodeShopifyApplyResult,
  encodeShopifyReconcileResult,
  shopifyOperationIdValid,
  shopifyShopPattern,
  shopifyWriteBudgetValid,
  shopifyWriteLimits,
  type OperationStatusName,
  type ShopifyApplyResult,
  type ShopifyReconcileResult,
} from "../../../packages/identity/src/broker-protocol.js";
import {
  changeItemText,
  listingSnapshotText,
  type ListingFieldsRead,
} from "../../../packages/work/src/runs/listing-canonical.js";
import {
  readbackVerdicts,
  type ApprovedSet,
} from "../../../packages/work/src/runs/listing-compare.js";
import {
  BrokerHold,
  brokerCapabilities,
  invokeBrokerMethod,
  type BrokerVault,
} from "./capabilities.js";
import type { VaultTransaction } from "./shopify-install.js";
import { sha256Hex, shopifyAdminGraphql, shopifyApiVersion, type ShopifyFetch } from "./shopify.js";
import { runVaultTransaction } from "./vault-database.js";
import {
  VaultError,
  openVaultRecord,
  vaultHexBytes,
  vaultLimits,
  vaultStatements,
  type VaultQuery,
} from "./vault.js";

export interface ShopifyWriteDependencies {
  readonly transaction: VaultTransaction;
  readonly fetch: ShopifyFetch;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}
/** The fixed documents of the write path (Admin GraphQL, the pinned API version). */
export const shopifyWriteDocuments = Object.freeze({
  productWriteState:
    "query ProductWriteState($id: ID!) { product(id: $id) { id title descriptionHtml tags seo { title description } updatedAt } }",
  productUpdate:
    "mutation ProductUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id updatedAt } userErrors { field message } } }",
} as const);
// Each vault transaction gets at most this much of the budget.
const vaultBudgetMs = 3000;
const updatedAtPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const productPattern = /^product:([1-9][0-9]{0,19})$/;
const requestIdPattern = /^[A-Za-z0-9-]{8,128}$/;
const listingFields: readonly string[] = [
  "descriptionHtml",
  "seo.description",
  "seo.title",
  "tags",
  "title",
];
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
const own = (value: unknown, key: string): unknown =>
  value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

// ---------------------------------------------------------------------------
// The write transport. Unlike the read helper (which turns every failure into `refused`), it
// keeps every reply class apart, because only some of them prove that nothing ran.
export type ShopifyWriteReply =
  | Readonly<{ kind: "data"; data: unknown; requestId: string | null }>
  | Readonly<{
      kind:
        | "not_sent"
        | "throttled"
        | "unauthorized"
        | "access_denied"
        | "graphql_error"
        | "status"
        | "server_error"
        | "transport"
        | "malformed";
    }>;
async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]{1,9}$/.test(declared) || Number(declared) > limit))
    return undefined;
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(item.value);
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}
/**
 * One fixed mutation. A THROTTLED reply (every error THROTTLED) proves nothing ran: one wait
 * for the bucket and one resend, within the deadline; a second THROTTLED, a 429 or no time
 * left after a THROTTLED is `throttled`. No time before the first request is `not_sent`. A
 * fetch exception or timeout is `transport` (fetch cannot tell a refused connection from a
 * lost reply).
 */
export async function shopifyAdminWrite(
  fetcher: ShopifyFetch,
  shop: string,
  token: string,
  document: string,
  variables: Readonly<Record<string, unknown>>,
  deadlineMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ShopifyWriteReply> {
  if (!shopifyShopPattern.test(shop)) return Object.freeze({ kind: "not_sent" });
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadlineMs - now();
    if (remaining <= 0) return Object.freeze({ kind: attempt === 0 ? "not_sent" : "throttled" });
    let response: Response;
    try {
      response = await fetcher(`https://${shop}/admin/api/${shopifyApiVersion}/graphql.json`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-shopify-access-token": token,
        },
        body: JSON.stringify({ query: document, variables }),
        signal: AbortSignal.timeout(remaining),
      });
    } catch {
      return Object.freeze({ kind: "transport" });
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) return Object.freeze({ kind: "unauthorized" });
      if (response.status === 429) return Object.freeze({ kind: "throttled" });
      if (response.status >= 500) return Object.freeze({ kind: "server_error" });
      return Object.freeze({ kind: "status" });
    }
    const header = response.headers.get("x-request-id");
    const requestId = exact(requestIdPattern, header) ? header : null;
    const reply = await boundedJson(response, shopifyWriteLimits.replyMaxBytes);
    if (reply === undefined || reply === null || typeof reply !== "object" || Array.isArray(reply))
      return Object.freeze({ kind: "malformed" });
    const errors = own(reply, "errors");
    if (errors !== undefined) {
      const list = Array.isArray(errors) ? errors : [];
      const codes = list.map((e) => own(own(e, "extensions"), "code"));
      if (list.length > 0 && codes.every((c) => c === "THROTTLED")) {
        if (attempt > 0) return Object.freeze({ kind: "throttled" });
        // Wait until the bucket holds the mutation's requested cost again (Shopify's
        // extensions.cost.requestedQueryCost; a productUpdate costs 10 when it is absent).
        const cost = own(own(reply, "extensions"), "cost");
        const status = own(cost, "throttleStatus");
        const requested = own(cost, "requestedQueryCost");
        const needed =
          typeof requested === "number" && Number.isFinite(requested) && requested > 0
            ? Math.min(requested, 1000)
            : 10;
        const available = own(status, "currentlyAvailable");
        const rate = own(status, "restoreRate");
        const wait =
          typeof available === "number" &&
          Number.isFinite(available) &&
          typeof rate === "number" &&
          Number.isFinite(rate) &&
          rate > 0
            ? Math.ceil((Math.max(0, needed - Math.max(0, available)) / rate) * 1000)
            : 1000;
        if (now() + wait >= deadlineMs) return Object.freeze({ kind: "throttled" });
        await sleep(wait);
        continue;
      }
      if (codes.includes("ACCESS_DENIED")) return Object.freeze({ kind: "access_denied" });
      return Object.freeze({ kind: "graphql_error" });
    }
    const data = own(reply, "data");
    if (data === undefined || data === null || typeof data !== "object")
      return Object.freeze({ kind: "malformed" });
    return Object.freeze({ kind: "data", data, requestId });
  }
  return Object.freeze({ kind: "throttled" });
}

export type WriteClassification = Readonly<{
  outcome: "submitted" | "failed" | "uncertain";
  reason:
    | "provider_accepted"
    | "provider_rejected"
    | "throttled"
    | "connection_unauthorized"
    | "access_denied"
    | "not_sent"
    | "transport_lost"
    | "server_error"
    | "unexpected_status"
    | "graphql_error"
    | "reply_malformed";
}>;
/**
 * The outcome of one productUpdate reply (spine §8; ADR-0022 item 7). Not sent, proven: no
 * request made, THROTTLED or 429, 401, ACCESS_DENIED, and userErrors (Shopify applies nothing
 * when it reports them). Submitted: no userErrors and the reply names this product. Anything
 * else (a lost reply, a 5xx, another status, another GraphQL error, a malformed reply or
 * another product) is uncertain: settled only by reading the product back.
 */
export function classifyProductUpdate(reply: ShopifyWriteReply, productGid: string): WriteClassification {
  const r = (outcome: WriteClassification["outcome"], reason: WriteClassification["reason"]) =>
    Object.freeze({ outcome, reason });
  switch (reply.kind) {
    case "not_sent":
      return r("failed", "not_sent");
    case "throttled":
      return r("failed", "throttled");
    case "unauthorized":
      return r("failed", "connection_unauthorized");
    case "access_denied":
      return r("failed", "access_denied");
    case "graphql_error":
      return r("uncertain", "graphql_error");
    case "status":
      return r("uncertain", "unexpected_status");
    case "server_error":
      return r("uncertain", "server_error");
    case "transport":
      return r("uncertain", "transport_lost");
    case "malformed":
      return r("uncertain", "reply_malformed");
    case "data": {
      const update = own(reply.data, "productUpdate");
      const userErrors = own(update, "userErrors");
      if (!Array.isArray(userErrors)) return r("uncertain", "reply_malformed");
      if (userErrors.length > 0) return r("failed", "provider_rejected");
      if (own(own(update, "product"), "id") !== productGid) return r("uncertain", "reply_malformed");
      return r("submitted", "provider_accepted");
    }
  }
}

/** The productUpdate input of one approved set: the product id and only the approved keys. */
export function productUpdateInput(productGid: string, set: ApprovedSet): Record<string, unknown> {
  const input: Record<string, unknown> = { id: productGid };
  if (set.title !== undefined) input.title = set.title;
  if (set.descriptionHtml !== undefined) input.descriptionHtml = set.descriptionHtml;
  if (set.seo !== undefined) input.seo = { title: set.seo.title, description: set.seo.description };
  if (set.tags !== undefined) input.tags = [...set.tags];
  return input;
}

// The listing fields and updatedAt of one ProductWriteState reply: `missing` when Shopify has
// no such product, null for any other shape.
function writeState(
  data: unknown,
  productId: string,
): Readonly<{ product: ListingFieldsRead; updatedAt: string }> | "missing" | null {
  const p = own(data, "product");
  if (p === null) return "missing";
  const match = productPattern.exec(productId);
  if (!match || own(p, "id") !== "gid://shopify/Product/" + match[1]) return null;
  const title = own(p, "title");
  const descriptionHtml = own(p, "descriptionHtml");
  const tags = own(p, "tags");
  const seo = own(p, "seo");
  const seoTitle = own(seo, "title");
  const seoDescription = own(seo, "description");
  const updatedAt = own(p, "updatedAt");
  if (
    typeof title !== "string" ||
    typeof descriptionHtml !== "string" ||
    !Array.isArray(tags) ||
    !tags.every((t) => typeof t === "string") ||
    !(seoTitle === null || typeof seoTitle === "string") ||
    !(seoDescription === null || typeof seoDescription === "string") ||
    !exact(updatedAtPattern, updatedAt)
  )
    return null;
  return Object.freeze({
    product: Object.freeze({
      productId,
      title,
      descriptionHtml,
      seo: Object.freeze({ title: seoTitle, description: seoDescription }),
      tags: Object.freeze([...(tags as string[])]),
    }),
    updatedAt,
  });
}
// The claimed item (a CatalogContentChangeSet@1 item) as the definer returned it: exactly
// {targetIndex, productId, set}, the set's keys following the fields.
function parseItem(text: unknown, productId: string, fields: readonly string[]) {
  if (typeof text !== "string") return null;
  let item: unknown;
  try {
    item = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !item ||
    typeof item !== "object" ||
    Array.isArray(item) ||
    Object.keys(item).sort().join(",") !== "productId,set,targetIndex"
  )
    return null;
  const v = item as { targetIndex: unknown; productId: unknown; set: unknown };
  if (
    !Number.isSafeInteger(v.targetIndex) ||
    v.productId !== productId ||
    !v.set ||
    typeof v.set !== "object" ||
    Array.isArray(v.set)
  )
    return null;
  const keys = [...new Set(fields.map((f) => (f.startsWith("seo.") ? "seo" : f)))].sort();
  if (Object.keys(v.set).sort().join(",") !== keys.join(",")) return null;
  return v as { targetIndex: number; productId: string; set: ApprovedSet };
}
function parseFields(text: unknown): readonly string[] | null {
  if (typeof text !== "string" || text === "") return null;
  const fields = text.split(",");
  return fields.every((f) => listingFields.includes(f)) && new Set(fields).size === fields.length
    ? fields
    : null;
}
function parseSnapshot(text: unknown, productId: string): ListingFieldsRead | null {
  if (typeof text !== "string") return null;
  try {
    const s = JSON.parse(text) as Record<string, unknown>;
    const seo = s.seo as Record<string, unknown> | undefined;
    if (
      s.productId !== productId ||
      typeof s.title !== "string" ||
      typeof s.descriptionHtml !== "string" ||
      !seo ||
      !(seo.title === null || typeof seo.title === "string") ||
      !(seo.description === null || typeof seo.description === "string") ||
      !Array.isArray(s.tags) ||
      !s.tags.every((t) => typeof t === "string")
    )
      return null;
    return {
      productId,
      title: s.title,
      descriptionHtml: s.descriptionHtml,
      seo: { title: seo.title as string | null, description: seo.description as string | null },
      tags: s.tags as string[],
    };
  } catch {
    return null;
  }
}
const statusName = (value: unknown): OperationStatusName | null =>
  typeof value === "string" &&
  [
    "dispatching",
    "submitted",
    "verifying",
    "verified",
    "conflict",
    "failed",
    "uncertain",
    "authorized",
    "planned",
    "awaiting_approval",
    "rejected",
    "reserved",
    "cancel_requested",
    "cancelled",
  ].includes(value)
    ? (value as OperationStatusName)
    : null;
function one(rows: readonly Record<string, unknown>[], columns: readonly string[]) {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || Object.keys(row).sort().join(",") !== [...columns].sort().join(","))
    throw new VaultError("VAULT_RECORD_INVALID");
  return row;
}
// The token of one resolved row, opened with the KEK, used by `use`, its bytes zeroed after.
async function withToken<T>(
  vault: Readonly<BrokerVault>,
  r: Record<string, unknown>,
  use: (token: string, shop: string) => Promise<T>,
): Promise<T> {
  const { organization_id: org, workspace_id: ws, credential_id: credential } = r;
  const { store_installation_id: installation, shop_domain: shop } = r;
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
      wrappedKey: vaultHexBytes(r.wrapped_key, vaultLimits.wrappedKeyBytes, vaultLimits.wrappedKeyBytes),
      sealedValue: vaultHexBytes(r.sealed_value, vaultLimits.sealedMinBytes, vaultLimits.sealedMaxBytes),
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
  try {
    return await use(token, shop);
  } finally {
    token = "";
  }
}

const resolveColumns = [
  "outcome",
  "status",
  "reason",
  "organization_id",
  "workspace_id",
  "shop_domain",
  "product_id",
  "fields",
  "item",
  "request_digest",
  "expected_source_revision",
  "store_installation_id",
  "credential_id",
  "credential_version",
  "kek_version",
  "wrapped_key",
  "sealed_value",
] as const;
const reconcileColumns = [
  "outcome",
  "status",
  "organization_id",
  "workspace_id",
  "shop_domain",
  "product_id",
  "fields",
  "item",
  "source",
  "source_updated_at",
  "store_installation_id",
  "credential_id",
  "credential_version",
  "kek_version",
  "wrapped_key",
  "sealed_value",
] as const;
/** Write and read-back resolutions on the vault login at once per broker isolate. */
export const shopifyWriteSlots = 1;

export function createShopifyWriter(deps: Readonly<ShopifyWriteDependencies>) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let writing = 0;
  let reading = 0;
  async function slot<T>(kind: "write" | "read", run: () => Promise<T>): Promise<T> {
    if (kind === "write" ? writing >= shopifyWriteSlots : reading >= shopifyWriteSlots)
      throw new BrokerHold(kind === "write" ? "WRITE_BUSY" : "READ_BUSY");
    if (kind === "write") writing++;
    else reading++;
    try {
      return await run();
    } finally {
      if (kind === "write") writing--;
      else reading--;
    }
  }
  const vaultCall = <T>(
    vault: Readonly<BrokerVault>,
    deadline: number,
    body: (query: VaultQuery) => Promise<T>,
  ) => deps.transaction(vault, Math.max(1, Math.min(vaultBudgetMs, deadline - deps.now())), body);
  const result = (outcome: ShopifyApplyResult["outcome"], status: unknown, reason: unknown) =>
    encodeShopifyApplyResult({
      outcome,
      status: statusName(status),
      reason: typeof reason === "string" ? reason : null,
    });

  async function apply(env: unknown, operationId: unknown, budgetMs: unknown): Promise<string> {
    // 0. The switch, before any input, database or Shopify access.
    const capabilities = await brokerCapabilities(env);
    if (capabilities.shopifyWrite !== "on") throw new BrokerHold("WRITE_UNAVAILABLE");
    if (!shopifyOperationIdValid(operationId)) throw new BrokerHold("INPUT_INVALID");
    if (!shopifyWriteBudgetValid(budgetMs)) throw new BrokerHold("BUDGET_INVALID");
    const vault = capabilities.vault;
    if (!vault) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
    const deadline = deps.now() + budgetMs;
    return slot("write", async () => {
      // 1. T1.
      const r = await vaultCall(vault, deadline, async (query) =>
        one(await query(vaultStatements.catalogWriteResolve, [operationId]), resolveColumns),
      );
      if (r.outcome === "refused") return result("refused", r.status, r.reason);
      if (r.outcome === "in_flight" || r.outcome === "settled")
        return result(r.outcome, r.status, null);
      if (r.outcome !== "resolved") throw new BrokerHold("STATE_INVALID");
      const fields = parseFields(r.fields);
      const productId = r.product_id;
      if (
        !fields ||
        !exact(productPattern, productId) ||
        !exact(/^[a-f0-9]{64}$/, r.request_digest) ||
        !exact(/^[a-f0-9]{64}$/, r.expected_source_revision)
      )
        throw new VaultError("VAULT_RECORD_INVALID");
      const productGid = "gid://shopify/Product/" + productPattern.exec(productId)![1];
      // 2. The exact approved item.
      const item = parseItem(r.item, productId, fields);
      const matches =
        item !== null && (await sha256Hex(changeItemText(item))) === r.request_digest;
      return withToken(vault, r, async (token, shop) => {
        // 3. The pre-send read (skipped for a mismatched item: nothing is sent either way).
        let presend: "read" | "not_found" | "unauthorized" | "mismatch" = "mismatch";
        let digest = "";
        let updatedAt = "";
        if (matches) {
          const read = await shopifyAdminGraphql(
            deps.fetch,
            shop,
            token,
            shopifyWriteDocuments.productWriteState,
            { id: productGid },
            Math.min(deadline, deps.now() + shopifyWriteLimits.readMs),
            deps.now,
            sleep,
            shopifyWriteLimits.replyMaxBytes,
          );
          if (read.kind === "unauthorized") presend = "unauthorized";
          else if (read.kind !== "data") return result("held", "dispatching", null);
          else {
            const state = writeState(read.data, productId);
            if (state === null) return result("held", "dispatching", null);
            if (state === "missing") presend = "not_found";
            else {
              presend = "read";
              digest = await sha256Hex(listingSnapshotText(state.product));
              updatedAt = state.updatedAt;
            }
          }
        }
        // 4. T2, the fence, committed before any request.
        let begun: Record<string, unknown>;
        try {
          begun = await vaultCall(vault, deadline, async (query) =>
            one(
              await query(vaultStatements.catalogWriteBegin, [
                operationId,
                presend,
                digest,
                updatedAt,
                r.credential_version as string,
              ]),
              ["outcome", "status", "reason"],
            ),
          );
        } catch (error) {
          // Nothing was sent. If the fence committed, the read-back settles it.
          if (error instanceof BrokerHold) throw error;
          throw new BrokerHold("OUTCOME_UNKNOWN");
        }
        if (begun.outcome === "refused") return result("refused", begun.status, begun.reason);
        if (begun.outcome === "in_flight" || begun.outcome === "settled")
          return result(begun.outcome, begun.status, null);
        if (begun.outcome !== "send" || item === null) throw new BrokerHold("STATE_INVALID");
        // 5. The one send.
        const reply = await shopifyAdminWrite(
          deps.fetch,
          shop,
          token,
          shopifyWriteDocuments.productUpdate,
          { product: productUpdateInput(productGid, item.set) },
          Math.min(deadline, deps.now() + shopifyWriteLimits.sendMs),
          deps.now,
          sleep,
        );
        const classified = classifyProductUpdate(reply, productGid);
        // 6. T3.
        try {
          const ended = await vaultCall(vault, Math.max(deadline, deps.now() + vaultBudgetMs), async (query) =>
            one(
              await query(vaultStatements.catalogWriteEnd, [
                operationId,
                classified.outcome,
                classified.reason,
                reply.kind === "data" ? (reply.requestId ?? "") : "",
              ]),
              ["outcome"],
            ),
          );
          if (ended.outcome !== "recorded") return result("uncertain", null, "close_unknown");
        } catch {
          return result("uncertain", null, "close_unknown");
        }
        return result(
          classified.outcome,
          classified.outcome === "submitted" ? "submitted" : classified.outcome,
          classified.reason,
        );
      });
    });
  }

  async function reconcile(env: unknown, operationId: unknown, budgetMs: unknown): Promise<string> {
    if (!shopifyOperationIdValid(operationId)) throw new BrokerHold("INPUT_INVALID");
    if (!shopifyWriteBudgetValid(budgetMs)) throw new BrokerHold("BUDGET_INVALID");
    const capabilities = await brokerCapabilities(env);
    const vault = capabilities.vault;
    if (!vault) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
    const deadline = deps.now() + budgetMs;
    const reconciled = (
      outcome: ShopifyReconcileResult["outcome"],
      status: unknown,
      verdict: ShopifyReconcileResult["verdict"],
    ) => encodeShopifyReconcileResult({ outcome, status: statusName(status), verdict });
    return slot("read", async () => {
      const r = await vaultCall(vault, deadline, async (query) =>
        one(await query(vaultStatements.catalogReconcileResolve, [operationId]), reconcileColumns),
      );
      if (
        r.outcome === "closed" ||
        r.outcome === "too_soon" ||
        r.outcome === "unavailable" ||
        r.outcome === "settled"
      )
        return reconciled(r.outcome, r.status, null);
      if (r.outcome !== "resolved") throw new BrokerHold("STATE_INVALID");
      const fields = parseFields(r.fields);
      const productId = r.product_id;
      if (!fields || !exact(productPattern, productId)) throw new VaultError("VAULT_RECORD_INVALID");
      const item = parseItem(r.item, productId, fields);
      if (!item) throw new VaultError("VAULT_RECORD_INVALID");
      const source = r.source === null ? null : parseSnapshot(r.source, productId);
      if (!exact(updatedAtPattern, r.source_updated_at)) throw new VaultError("VAULT_RECORD_INVALID");
      const productGid = "gid://shopify/Product/" + productPattern.exec(productId)![1];
      return withToken(vault, r, async (token, shop) => {
        const read = await shopifyAdminGraphql(
          deps.fetch,
          shop,
          token,
          shopifyWriteDocuments.productWriteState,
          { id: productGid },
          Math.min(deadline, deps.now() + shopifyWriteLimits.readMs),
          deps.now,
          sleep,
          shopifyWriteLimits.replyMaxBytes,
        );
        // A read that proves nothing records nothing: the next read-back tries again.
        if (read.kind !== "data") return reconciled("held", r.status, null);
        const state = writeState(read.data, productId);
        if (state === null) return reconciled("held", r.status, null);
        let verdict: "approved" | "source" | "mixed" | "missing";
        let values: string[];
        if (state === "missing") {
          verdict = "missing";
          values = [operationId as string, "not_found", "", "", "missing"];
        } else {
          const compared = readbackVerdicts(state.product, item.set, source, fields);
          verdict = compared.verdict;
          values = [
            operationId as string,
            "read",
            state.updatedAt,
            JSON.stringify(compared.fields),
            compared.verdict,
          ];
        }
        const recorded = await vaultCall(
          vault,
          Math.max(deadline, deps.now() + vaultBudgetMs),
          async (query) =>
            one(await query(vaultStatements.catalogReconcileRecord, values), ["outcome", "status"]),
        );
        if (recorded.outcome === "recorded") return reconciled("recorded", recorded.status, verdict);
        if (recorded.outcome === "too_soon" || recorded.outcome === "settled")
          return reconciled(recorded.outcome, recorded.status, null);
        throw new BrokerHold("STATE_INVALID");
      });
    });
  }

  return Object.freeze({ apply, reconcile });
}

const live = createShopifyWriter({
  transaction: (vault, budgetMs, body) => runVaultTransaction(vault, budgetMs, body),
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
});
export function brokerShopifyProductApply(env: unknown, operationId: unknown, budgetMs: unknown) {
  return invokeBrokerMethod("shopifyProductApply", () => live.apply(env, operationId, budgetMs));
}
export function brokerShopifyProductReconcile(
  env: unknown,
  operationId: unknown,
  budgetMs: unknown,
) {
  return invokeBrokerMethod("shopifyProductReconcile", () =>
    live.reconcile(env, operationId, budgetMs),
  );
}
