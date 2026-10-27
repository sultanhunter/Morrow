// The store-content cleanup contract (P09.T05a; mvp-architecture §11; ADR-0022 items 13
// and 14): ONE list, in code, of every table that holds a store's content, identity or
// credential, with the handler that empties it. The tenant-conformance registry classifies
// every table of morrow_work, morrow_billing, morrow_vault and morrow_identity (`content`:
// none, workspace or store), and the conformance suite fails a store-content table without
// exactly one handler here (S8 and tests/redaction-handlers.test.mjs).
//
// `shop/redact` (M2 PR-3) runs every `shop_redact` handler for the store; the uninstall
// webhook (and, once its command lands, the human disconnect) run every
// `uninstall_or_disconnect` handler. Since M2 PR-3 every handler names its executor (the
// conformance check refuses a null one: invariant 16, no non-development store links before
// every handler runs, mvp.md M6):
//   * shop/redact: morrow_work.connector_inbox_apply (0037) first ends the installation (the
//     uninstall path, so a shop/redact that arrives first still destroys the token), then
//     runs morrow_work.store_content_redact (every work-schema handler: the proposal
//     parameters through parameters_redact_for_store, and since listings-runs (0038) the
//     store's product snapshots and run drafts, deleted in the connector's redaction context
//     only) and
//     morrow_identity.work_shopify_redact_identity (the installation, its candidate and
//     the app registry), and completes the privacy request only when nothing is
//     outstanding, the token's destruction included;
//   * app/uninstalled: the broker's shopifyCredentialDestroy
//     (morrow_vault.shopify_credential_destroy), which records the destruction on the
//     installation in the transaction that erases the key material; the connector's cron
//     re-drives every installation whose destruction is not yet recorded. v1 PR 5
//     (connection-health-work; ADR-0025 item 10): a scope change no longer ends the
//     installation or destroys its token; a reinstall destroys an earlier installation's
//     leftover token in its own install transaction (morrow_vault.shopify_install_prepare_v2);
//   * the 48-hour deletion (v1 PR 5; ADR-0031 item 3): when shop/redact has not come 48 hours
//     after an uninstall, morrow_work.connector_deletion_apply runs the same shop_redact
//     handlers once (store_content_redact, then work_shopify_redact_identity itself for the
//     identity's pseudonym and install link), and completes its content-free record
//     (morrow_identity.store_data_deletions) only when nothing is outstanding, the token's
//     destruction included.

export type StoreContentTrigger = "shop_redact" | "uninstall_or_disconnect";
export type StoreContentAction =
  /** Erase the key material of the active credential (morrow_vault, 0020 vault_guard). */
  | "destroy_credential"
  /** Empty the stored content, keep its digest (proposal_parameters, spine §11). */
  | "empty_keep_digest"
  /** Delete the rows (snapshots and drafts, M3). */
  | "delete_rows"
  /** Replace the shop domain with a pseudonym, keep the ids. */
  | "pseudonymise"
  /** Clear the app's install link, which names the shop; keep the shop digest. */
  | "clear_install_link";
export interface StoreContentHandler {
  /** schema.table, as the tenant-conformance registry names it. */
  readonly table: string;
  /** The data class of spine §11. */
  readonly dataClass: string;
  readonly trigger: StoreContentTrigger;
  readonly action: StoreContentAction;
  /** How the handler finds one store's rows. */
  readonly storeKey: string;
  /** The definer that runs it (never null since M2 PR-3: the conformance check refuses one). */
  readonly executor: string | null;
  /** The PR that made the handler executable, before the table held store content. */
  readonly executable: "M2 PR-3";
}

export const storeContentHandlers: readonly StoreContentHandler[] = Object.freeze(
  [
    {
      table: "morrow_vault.credentials",
      dataClass: "offline_token",
      trigger: "uninstall_or_disconnect",
      action: "destroy_credential",
      storeKey: "subject_id: the store installation the token belongs to",
      executor: "morrow_vault.shopify_credential_destroy",
      executable: "M2 PR-3",
    },
    {
      table: "morrow_identity.linking_candidates",
      dataClass: "shop_identity",
      trigger: "shop_redact",
      action: "pseudonymise",
      storeKey: "installation_id: the store installation the candidate proved (shop_id kept)",
      executor: "morrow_identity.work_shopify_redact_identity",
      executable: "M2 PR-3",
    },
    // M2 PR-2 review (0026): the app registry's install link names the shop (a
    // *.myshopify.com host, or the shop in a custom-distribution link's signed parameter).
    // Retirement clears it already; shop/redact clears it for the redacted installation's
    // own app only. An app registered later for the same shop (after the first was
    // uninstalled and retired), which may invite another tenant, keeps its link (M2 PR-3
    // review: shop/redact covers what Morrow holds through the app it was sent to). v1 PR 5
    // (connection-health-identity): the link is kept while the app has an installation
    // that is not uninstalled (a reinstall connects through it, and its live installation
    // holds the same shop domain), for shop/redact and the 48-hour deletion alike.
    {
      table: "morrow_identity.shopify_apps",
      dataClass: "shop_identity",
      trigger: "shop_redact",
      action: "clear_install_link",
      storeKey:
        "app_key and invited tenant: the redacted store installation's own app (never another app for the same shop digest)",
      executor: "morrow_identity.work_shopify_redact_identity",
      executable: "M2 PR-3",
    },
    // M2 PR-2 (0026): StoreInstallation@1 rows hold the shop domain and id (spine §11).
    {
      table: "morrow_identity.store_installations",
      dataClass: "shop_identity",
      trigger: "shop_redact",
      action: "pseudonymise",
      storeKey: "id: the store installation itself (shop_id kept)",
      executor: "morrow_identity.work_shopify_redact_identity",
      executable: "M2 PR-3",
    },
    {
      table: "morrow_work.proposal_parameters",
      dataClass: "product_content_proposed",
      trigger: "shop_redact",
      action: "empty_keep_digest",
      storeKey: "proposals.store_id through proposals.parameters_id",
      // The revisable owner helper of the M3 PR-1 agent-proposals migration: it empties the
      // canonical text and sets redacted_at, keeping the digest; decision_bind and the
      // approval_claims trigger refuse a redacted proposal. M2 PR-3 (0037) revises it to run
      // under the tenant's own session context or the connector's redaction context for
      // exactly that store (morrow.connector_redact, which only connector_inbox_apply writes),
      // with the connector_redact policies; anything else is still context_unavailable,
      // never an empty success. shop/redact reaches it through store_content_redact
      // (lab:shopify-privacy).
      executor: "morrow_work.parameters_redact_for_store",
      executable: "M2 PR-3",
    },
    // M3 PR-2 (listings-runs, 0038): the product text a run read and the drafts it wrote.
    // Both are keyed by store and expire after 90 days. A run reads a product only through
    // M2 PR-3's shopifyRead, and 0038 revises M2 PR-3's store_content_redact to delete both
    // in the same change that makes the read available, so neither table holds a store's
    // content before the handler can run. The deletion's evidence counts the rows that pass
    // deleted; the run steps that write them take the store's stop key shared, so a write
    // races shop/redact only by committing first (and being deleted) or being refused.
    {
      table: "morrow_work.product_snapshots",
      dataClass: "product_content_read",
      trigger: "shop_redact",
      action: "delete_rows",
      storeKey: "store_id: the store the product was read from",
      executor: "morrow_work.store_content_redact",
      executable: "M2 PR-3",
    },
    {
      table: "morrow_work.run_drafts",
      dataClass: "product_content_drafted",
      trigger: "shop_redact",
      action: "delete_rows",
      storeKey: "store_id: the store of the run that drafted it",
      executor: "morrow_work.store_content_redact",
      executable: "M2 PR-3",
    },
  ].map((handler) => Object.freeze(handler as StoreContentHandler)),
);

// The deletion path of the workspace-content classes that people and agents write (PR 20;
// ADR-0031 items 1, 3 and 4; G9: a class has its path before real data of that class). Shop
// knowledge pages "stay until a person deletes them, the store is redacted or the workspace is
// erased"; notebooks are clocked 90 days and go with their installation. No runtime role holds
// DELETE (tenant conformance S4), so each handler erases the content in place and keeps only
// ids, digests and times; the owner's retention sweep removes clocked rows past their clock.
// Built here: a person's page deletion (one transaction over every knowledge table below,
// recorded in knowledge_deletions and the command log) and a person's notebook clear. Not yet
// built, each with the work that brings its trigger: knowledge erased at shop/redact for a
// store-tagged page (with lab:shopify-privacy) and at workspace erasure
// (governance.privacy.erase), notebooks at agent uninstall, and the daily sweep of expired
// notebook entries.
export type WorkspaceContentTrigger = "person_delete" | "notebook_clear";
export interface WorkspaceContentHandler {
  /** schema.table, as the tenant-conformance registry names it. */
  readonly table: string;
  /** The class of ADR-0031 item 1. */
  readonly dataClass: "knowledge_pages" | "notebooks";
  readonly trigger: WorkspaceContentTrigger;
  /** Erase the text in place, keeping ids, digests and times. */
  readonly action: "erase_keep_digest";
  /** How the handler finds one target's rows. */
  readonly key: string;
  /** The definer that runs it. */
  readonly executor: string;
  readonly executable: "PR 20";
}
export const workspaceContentHandlers: readonly WorkspaceContentHandler[] = Object.freeze(
  (
    [
      {
        table: "morrow_work.knowledge_pages",
        dataClass: "knowledge_pages",
        trigger: "person_delete",
        action: "erase_keep_digest",
        key: "id: the page (its title; deleted_at and deleted_by record the act)",
        executor: "morrow_work.cmd_knowledge_delete",
        executable: "PR 20",
      },
      {
        table: "morrow_work.knowledge_versions",
        dataClass: "knowledge_pages",
        trigger: "person_delete",
        action: "erase_keep_digest",
        key: "page_id: every version of the page (title, text and sources)",
        executor: "morrow_work.cmd_knowledge_delete",
        executable: "PR 20",
      },
      {
        table: "morrow_work.knowledge_search_entries",
        dataClass: "knowledge_pages",
        trigger: "person_delete",
        action: "erase_keep_digest",
        key: "page_id: the page's full-text entry (its document)",
        executor: "morrow_work.cmd_knowledge_delete",
        executable: "PR 20",
      },
      {
        table: "morrow_work.knowledge_proposals",
        dataClass: "knowledge_pages",
        trigger: "person_delete",
        action: "erase_keep_digest",
        key: "page_id: the page's pending proposals, closed (a decision erases each one's text too)",
        executor: "morrow_work.cmd_knowledge_delete",
        executable: "PR 20",
      },
      {
        table: "morrow_work.agent_notebook_entries",
        dataClass: "notebooks",
        trigger: "notebook_clear",
        action: "erase_keep_digest",
        key: "installation_id: every live entry of the installation's notebook",
        executor: "morrow_work.cmd_notebook_clear",
        executable: "PR 20",
      },
    ] as const
  ).map((handler) => Object.freeze(handler as WorkspaceContentHandler)),
);

// ---------------------------------------------------------------------------------------------
// The customer-content cleanup contract (P09.T05; plan rows SD3 and SD4 of
// docs/plan/store-data-foundation-implementation.md; ADR-0031 items 2 to 4 and its 2026-10-26
// note on item 1; ADR-0042 items 15 and 24; ADR-0043 item 24). `customers/redact` names a
// customer by keys, never by content: the order ids it lists. Every table that holds a row
// keyed by one of them registers one handler here, on the matchers its keys need, in the
// pull request that first writes it (G9), and S8 fails a keyed table without it:
//
//   key (registry `customerKeys`, column name)   matcher
//   order_id (`order_id`, `*_order_id`, `order_ids`)  listed_orders: the ids the request lists
//
// The handler runs in morrow_work.customer_content_redact (customer-deletion-work), the
// registration surface: a revisable owner helper that the registering migration replaces,
// adding the table to morrow_identity.customer_handler_tables() (the closed list a request's
// evidence may name) in the same change. It runs only in the connector's customer redaction
// context for the request's store (morrow.connector_customer), under the store's stop key held
// exclusively; a writer of a keyed class takes that key shared, so a racing write commits first
// and is redacted, or writes after. The request completes only when every handler reports zero
// rows still matching; until then the delivery stays received, its request open, and its inbox
// row (with the listed ids) outlives its 7-day clock.
//
// A `content: customer` table (customer data under ADR-0031's Terms: a 90-day clock, never
// extended by a copy) also needs its shop/redact handler above, and must carry at least one key:
// a class that no key can find is unmatchable and fails S8.
export type CustomerKey = "order_id";
export type CustomerMatcher = "listed_orders";
/** The matcher each key needs (S8 checks every key of a table against its handler). */
export const customerKeyMatchers: Readonly<Record<CustomerKey, CustomerMatcher>> = Object.freeze({
  order_id: "listed_orders",
});
export type CustomerContentAction =
  /** Delete the matching rows. */
  | "delete_rows"
  /** Blank the order id of a content-free row, keeping its codes and counts (ADR-0043 item 24). */
  | "blank_order_id"
  /** Empty the stored content, keep its digest (a proposal's parameters). */
  | "empty_keep_digest"
  /** Erase the text in place, keep ids, digests and times. */
  | "erase_keep_digest";
export interface CustomerContentHandler {
  /** schema.table, as the tenant-conformance registry names it. */
  readonly table: string;
  /** The class of ADR-0031 item 1 (or of the record that adds it). */
  readonly dataClass: string;
  readonly trigger: "customers_redact";
  /** Every matcher this handler applies: at least the ones its table's keys need. */
  readonly matchers: readonly CustomerMatcher[];
  readonly action: CustomerContentAction;
  /** How the handler finds the matching rows. */
  readonly key: string;
  /** The registration surface that runs it. */
  readonly executor: "morrow_work.customer_content_redact";
  /** The pull request that registered it, before the table held a keyed row. */
  readonly executable: string;
}
/**
 * Every registered customer-content handler. None yet: no table is keyed by an order, a
 * customer id or a customer digest at this head; V1-PR22's order classes, CS8's order events,
 * SD9b's projections and the contact classes (CS9, CS12) register theirs.
 */
export const customerContentHandlers: readonly CustomerContentHandler[] = Object.freeze(
  [] as CustomerContentHandler[],
);
