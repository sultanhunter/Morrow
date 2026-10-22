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
//     runs morrow_work.store_content_redact (every work-schema handler, here the proposal
//     parameters through parameters_redact_for_store) and
//     morrow_identity.work_shopify_redact_identity (the installation, its candidate and
//     the app registry), and completes the privacy request only when nothing is
//     outstanding, the token's destruction included;
//   * app/uninstalled (and a scope change): the broker's shopifyCredentialDestroy
//     (morrow_vault.shopify_credential_destroy), which records the destruction on the
//     installation in the transaction that erases the key material; the connector's cron
//     re-drives every installation whose destruction is not yet recorded.

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
    // review: shop/redact covers what Morrow holds through the app it was sent to).
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
  ].map((handler) => Object.freeze(handler as StoreContentHandler)),
);
