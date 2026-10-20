// The store resource and the listing field paths (ADR-0022 items 1-3; mvp-architecture
// §7). Pure: no I/O, clock or randomness.
//
// Every catalogue permission is evaluated on the connected store as a whole,
// {kind: "store", id: S, storeId: S, connectionId: C}: run admission, catalogue reads,
// every agent step, the claim and dispatch. The kernels match resources exactly, so a
// grant on the store resource covers only requests on that store resource; code then
// checks that every product target has the same store and connection. The store-link
// template (M2 PR-2), installation grants and kernel requests (M3 PR-1) build the
// resource here, so there is one constructor and one field list.
import type { Current_ResourceRef } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";

/**
 * The listing FieldPaths (ADR-0022 item 1), sorted: the product fields a Listings
 * proposal may change. ADR-0022 item 1 fixes these catalogue FieldPaths; catalog.* store
 * grants and kernel requests name exactly these, never the capability's input names
 * (`productIds`, `proposalRef` and so on). Governance grants differ: their fields are
 * input names (ADR-0009 item 7, the owner-bootstrap-v1 rule).
 */
export const listingFieldPaths = Object.freeze([
  "descriptionHtml",
  "seo.description",
  "seo.title",
  "tags",
  "title",
] as const);
export type ListingFieldPath = (typeof listingFieldPaths)[number];

export class StoreResourceError extends Error {
  constructor(readonly code: "STORE_RESOURCE_INPUT_INVALID") {
    super(code);
    this.name = "StoreResourceError";
  }
}

/** A store resource for the kernels: kind store, id = storeId, both store keys set. */
export type StoreResource = Current_ResourceRef & {
  readonly kind: "store";
  readonly storeId: string;
  readonly connectionId: string;
};

/**
 * The store resource of one connected store. Every argument is a server-resolved id (the
 * session's tenant and the store installation row), never a client value. Throws
 * `STORE_RESOURCE_INPUT_INVALID` unless each is a string Id and the result is a valid
 * current ResourceRef. The result is frozen.
 */
export function storeResource(
  organizationId: string,
  workspaceId: string,
  storeId: string,
  connectionId: string,
): StoreResource {
  const ids = [organizationId, workspaceId, storeId, connectionId];
  if (!ids.every((id) => typeof id === "string" && validateCurrentDefinition("Id", id)))
    throw new StoreResourceError("STORE_RESOURCE_INPUT_INVALID");
  const resource = Object.freeze({
    organizationId,
    workspaceId,
    storeId,
    connectionId,
    kind: "store" as const,
    id: storeId,
  });
  if (!validateCurrentDefinition("ResourceRef", resource))
    throw new StoreResourceError("STORE_RESOURCE_INPUT_INVALID");
  return resource;
}

/** True when `value` is exactly a store resource: a valid current ResourceRef of kind store. */
export function isStoreResource(value: unknown): value is StoreResource {
  return (
    validateCurrentDefinition("ResourceRef", value) && (value as { kind: string }).kind === "store"
  );
}
