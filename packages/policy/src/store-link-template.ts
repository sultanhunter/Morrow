// The store-link grant template (ADR-0022 item 3; mvp-architecture §6 and §7). Pure: no
// I/O, clock or randomness.
//
// link_workspace_store (migration 0026) applies this template in the link transaction: the
// linking owner receives one grant per row on the store resource of the store just linked,
// {kind: "store", id: S, storeId: S, connectionId: C} (storeResource), with scope.storeIds
// [S] and accountIds [], issued by the service morrow.linking, never expiring. The SQL
// function morrow_identity.store_link_grants_v1() is the authority; this is its TypeScript
// twin, which tests/store-link-template.test.mjs pins equal to the SQL text, and which M3
// PR-1 reads to check that an installation's grants are a subset of the owner's.
//
// Fields are the request's input names (the owner-bootstrap-v1 rule): the catalogue grants
// use exactly the listing FieldPaths, and agents.installation.activate its v1 input names.
import { listingFieldPaths } from "./store-resource";

export interface StoreLinkGrantRow {
  readonly capabilityId:
    | "catalog.products.read"
    | "catalog.content.propose"
    | "catalog.content.publish"
    | "agents.installation.activate";
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

/** The template's identifier, for audit text and the SQL function's name (v1). */
export const storeLinkTemplateId = "store-link-v1";
/** The service principal that issues the template's grants. */
export const storeLinkIssuer = "morrow.linking";

/** The four rows, in the SQL function's order. */
export const storeLinkGrantTemplate: readonly StoreLinkGrantRow[] = Object.freeze([
  row("catalog.products.read", ["view", "delegate"], listingFieldPaths),
  row("catalog.content.propose", ["execute", "delegate"], listingFieldPaths),
  row("catalog.content.publish", ["propose", "approve", "execute", "delegate"], listingFieldPaths),
  row(
    "agents.installation.activate",
    ["execute"],
    ["evaluation", "grant", "installationId", "revision"],
  ),
]);
