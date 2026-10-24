// v1 PR 4: closed decoders of the catalogue routes' replies (M2 PR-3, packages/work/src/
// catalog/http.ts), for the product picker on Ask: a page of a linked store's products (ids,
// titles and status) or collections (ids and titles) and Shopify's opaque cursor. A body that
// does not match exactly decodes to null (an unconfirmed read), never a guess.
import type {
  CatalogCollectionView,
  CatalogPageView,
  CatalogProductView,
} from "@morrow/workspace-ui";

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactly = (value: Json, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
const title = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 1024 && !value.includes("\0");
const cursor = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && /^[A-Za-z0-9+/=_-]{1,1536}$/.test(value));

function page<T>(
  body: unknown,
  storeId: string,
  key: "products" | "collections",
  item: (value: unknown) => T | null,
): CatalogPageView<T> | null {
  if (
    !record(body) ||
    !exactly(body, ["schemaVersion", key, "nextCursor", "storeId"]) ||
    body.schemaVersion !== 1 ||
    body.storeId !== storeId ||
    !cursor(body.nextCursor) ||
    !Array.isArray(body[key]) ||
    (body[key] as unknown[]).length > 25
  )
    return null;
  const items: T[] = [];
  for (const value of body[key] as unknown[]) {
    const decoded = item(value);
    if (decoded === null) return null;
    items.push(decoded);
  }
  return { items, nextCursor: body.nextCursor as string | null };
}

/** GET /workspace/:ws/stores/:storeId/catalog/products: one page of the store's products. */
export function decodeCatalogProducts(
  body: unknown,
  storeId: string,
): CatalogPageView<CatalogProductView> | null {
  return page(body, storeId, "products", (v) =>
    record(v) &&
    exactly(v, ["id", "title", "status"]) &&
    typeof v.id === "string" &&
    /^product:[1-9][0-9]{0,19}$/.test(v.id) &&
    title(v.title) &&
    typeof v.status === "string" &&
    /^[a-z][a-z_]{0,31}$/.test(v.status)
      ? { id: v.id, title: v.title, status: v.status }
      : null,
  );
}

/** GET /workspace/:ws/stores/:storeId/catalog/collections: one page of its collections. */
export function decodeCatalogCollections(
  body: unknown,
  storeId: string,
): CatalogPageView<CatalogCollectionView> | null {
  return page(body, storeId, "collections", (v) =>
    record(v) &&
    exactly(v, ["id", "title"]) &&
    typeof v.id === "string" &&
    /^collection:[1-9][0-9]{0,19}$/.test(v.id) &&
    title(v.title)
      ? { id: v.id, title: v.title }
      : null,
  );
}
