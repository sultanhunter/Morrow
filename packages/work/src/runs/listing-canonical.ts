import { canonicalJson } from "../digest.js";

// The canonical text of a product's listing fields as Morrow reads them (M3's snapshot; v1
// PR 3's gateway). Pure and validator-free, so the broker's pre-send check computes exactly
// the digest a Listings run stored as the draft's expectedSourceRevision: sha256 of this
// text. drafting.ts builds its snapshots with it, so the two agree by construction; the
// broker never validates against the schema (equality with the stored digest already implies
// a valid snapshot). Exact duplicate tags are dropped, the first kept (readSnapshot's rule).

export interface ListingFieldsRead {
  readonly productId: string;
  readonly title: string;
  readonly descriptionHtml: string;
  readonly seo: { readonly title: string | null; readonly description: string | null };
  readonly tags: readonly string[];
}

/** The canonical snapshot text of one product as read. */
export function listingSnapshotText(product: ListingFieldsRead): string {
  return canonicalJson({
    productId: product.productId,
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    seo: { title: product.seo.title, description: product.seo.description },
    tags: [...new Set(product.tags)],
  });
}

/** The canonical text of one CatalogContentChangeSet@1 item: its request digest's input. */
export function changeItemText(item: {
  readonly targetIndex: number;
  readonly productId: string;
  readonly set: unknown;
}): string {
  return canonicalJson({ targetIndex: item.targetIndex, productId: item.productId, set: item.set });
}
