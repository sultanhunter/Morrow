// The store-content cleanup contract (P09.T05a; mvp-architecture §11; ADR-0022 items 13
// and 14): ONE list, in code, of every table that holds a store's content, identity or
// credential, with the handler that empties it. The tenant-conformance registry classifies
// every table of morrow_work, morrow_billing, morrow_vault and morrow_identity (`content`:
// none, workspace or store), and the conformance suite fails a store-content table without
// exactly one handler here (S8 and tests/redaction-handlers.test.mjs).
//
// `shop/redact` (M2 PR-3) runs every `shop_redact` handler for the store; the uninstall
// webhook and the human disconnect run every `uninstall_or_disconnect` handler. A handler
// whose executor is null is declared but not yet executable: its table holds no store
// content until the PR named in `executable` (invariant 16: no non-development store links
// before every handler runs, mvp.md M6).

export type StoreContentTrigger = "shop_redact" | "uninstall_or_disconnect";
export type StoreContentAction =
  /** Erase the key material of the active credential (morrow_vault, 0020 vault_guard). */
  | "destroy_credential"
  /** Empty the stored content, keep its digest (proposal_parameters, spine §11). */
  | "empty_keep_digest"
  /** Delete the rows (snapshots and drafts, M3). */
  | "delete_rows"
  /** Replace the shop domain with a pseudonym, keep the ids. */
  | "pseudonymise";
export interface StoreContentHandler {
  /** schema.table, as the tenant-conformance registry names it. */
  readonly table: string;
  /** The data class of spine §11. */
  readonly dataClass: string;
  readonly trigger: StoreContentTrigger;
  readonly action: StoreContentAction;
  /** How the handler finds one store's rows. */
  readonly storeKey: string;
  /** The definer or broker method that runs it; null until it lands. */
  readonly executor: string | null;
  /** The PR that makes the handler executable, before the table holds store content. */
  readonly executable: "M2 PR-3" | "M3 PR-1";
}

export const storeContentHandlers: readonly StoreContentHandler[] = Object.freeze(
  [
    {
      table: "morrow_vault.credentials",
      dataClass: "offline_token",
      trigger: "uninstall_or_disconnect",
      action: "destroy_credential",
      storeKey: "subject_id: the store installation the token belongs to",
      executor: null,
      executable: "M2 PR-3",
    },
    {
      table: "morrow_identity.linking_candidates",
      dataClass: "shop_identity",
      trigger: "shop_redact",
      action: "pseudonymise",
      storeKey: "installation_id: the store installation the candidate proved (shop_id kept)",
      executor: null,
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
      // approval_claims trigger refuse a redacted proposal. M2 PR-3's shop/redact definer
      // calls it for the store.
      executor: "morrow_work.parameters_redact_for_store",
      executable: "M3 PR-1",
    },
  ].map((handler) => Object.freeze(handler as StoreContentHandler)),
);
