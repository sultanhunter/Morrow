// The store-link grant template (ADR-0022 item 3; mvp-architecture §6 and §7). Pure: no
// I/O, clock or randomness.
//
// link_workspace_store applies this template in the link transaction: the linking owner
// receives one grant per row on the store resource of the store just linked,
// {kind: "store", id: S, storeId: S, connectionId: C} (storeResource), with scope.storeIds
// [S] and accountIds [], issued by the service morrow.linking, never expiring. The SQL
// function is the authority; this is its TypeScript twin, which
// tests/store-link-template.test.mjs pins equal to the SQL text, and which M3 PR-1 reads to
// check that an installation's grants are a subset of the owner's.
//   * Version 1 (migration 0026, morrow_identity.store_link_grants_v1()): the four
//     catalogue and activation rows.
//   * Version 2 (the disconnect-store identity migration,
//     morrow_identity.store_link_grants_v2()): version 1 plus governance.connection.disconnect
//     {execute}, the human kill switch "Disconnect store" (ADR-0022 item 3 as amended
//     2026-10-22, owner decision 8). The same migration issues that one grant to every
//     linking owner who holds the version 1 rows on a store still linked, and nothing else.
//
// Fields are the request's input names (the owner-bootstrap-v1 rule): the catalogue grants
// use exactly the listing FieldPaths, agents.installation.activate its v1 input names and
// governance.connection.disconnect its v1.1 input names (connectionId and control).
import { listingFieldPaths } from "./store-resource";

export interface StoreLinkGrantRow {
  readonly capabilityId:
    | "catalog.products.read"
    | "catalog.content.propose"
    | "catalog.content.publish"
    | "agents.installation.activate"
    | "governance.connection.disconnect";
  readonly verbs: readonly string[];
  readonly fields: readonly string[];
}

const row = (
  capabilityId: StoreLinkGrantRow["capabilityId"],
  verbs: readonly string[],
  fields: readonly string[],
): StoreLinkGrantRow =>
  Object.freeze({
    capabilityId,
    verbs: Object.freeze([...verbs]),
    fields: Object.freeze([...fields]),
  });

/** The template's identifier, for audit text and the SQL function's name (v2). */
export const storeLinkTemplateId = "store-link-v2";
/** The service principal that issues the template's grants. */
export const storeLinkIssuer = "morrow.linking";
/** The fields of the disconnect grant and of a "Disconnect store" request. */
export const disconnectFields: readonly string[] = Object.freeze(["connectionId", "control"]);

/** Version 1's four rows, in store_link_grants_v1()'s order (migration 0026). */
export const storeLinkGrantTemplateV1: readonly StoreLinkGrantRow[] = Object.freeze([
  row("catalog.products.read", ["view", "delegate"], listingFieldPaths),
  row("catalog.content.propose", ["execute", "delegate"], listingFieldPaths),
  row("catalog.content.publish", ["propose", "approve", "execute", "delegate"], listingFieldPaths),
  row(
    "agents.installation.activate",
    ["execute"],
    ["evaluation", "grant", "installationId", "revision"],
  ),
]);
/** The current template (version 2): five rows, in store_link_grants_v2()'s order. */
export const storeLinkGrantTemplate: readonly StoreLinkGrantRow[] = Object.freeze([
  ...storeLinkGrantTemplateV1,
  row("governance.connection.disconnect", ["execute"], disconnectFields),
]);
