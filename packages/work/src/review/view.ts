import type { Current_Proposal } from "@morrow/contracts";

// The review screen's per-product, per-field comparison (v1 PR 3; spine §2 step 10;
// ADR-0022 items 1 and 13; ADR-0027 item 5: product text is untrusted content). Pure: it
// takes the stored proposal, its CatalogContentChangeSet@1 parameters, the snapshots the
// drafts were made from and the drafts' reviewer flags, and returns plain values. It decides
// nothing: the approval binds the proposal's digest, never this view. Every value is text the
// screen shows as text (a description's HTML included, never rendered), so a product's own
// text cannot become markup, a link or an instruction.

export type ListingField = "descriptionHtml" | "seo.description" | "seo.title" | "tags" | "title";
export interface FieldChange {
  readonly field: ListingField;
  /** The value as drafted from; null when the snapshot is gone, or Shopify had none. */
  readonly before: string | readonly string[] | null;
  readonly after: string | readonly string[];
}
export interface ReviewFlags {
  readonly newUrls: number;
  readonly newEmails: number;
  readonly newPhones: number;
  readonly tagsAdded: number;
  readonly tagsRemoved: number;
}
export interface ProductReview {
  /** The target's index in the root proposal (the item's targetIndex). */
  readonly targetIndex: number;
  readonly productId: string;
  /** available: before values known; expired: the 90-day snapshot is gone; redacted: shop/redact. */
  readonly source: "available" | "expired" | "redacted";
  readonly changes: readonly FieldChange[];
  /** Added and removed tags (compared case-insensitively), when tags change. */
  readonly tags: { readonly added: readonly string[]; readonly removed: readonly string[] } | null;
  readonly flags: ReviewFlags | null;
}
export interface ReviewSource {
  readonly targetIndex: number;
  readonly productId: string;
  readonly state: "available" | "expired" | "redacted";
  /** The snapshot's canonical text when available. */
  readonly snapshot: string | null;
}
interface Snapshot {
  readonly productId: string;
  readonly title: string;
  readonly descriptionHtml: string;
  readonly seo: { readonly title: string | null; readonly description: string | null };
  readonly tags: readonly string[];
}
interface Item {
  readonly targetIndex: number;
  readonly productId: string;
  readonly set: {
    readonly title?: string;
    readonly descriptionHtml?: string;
    readonly seo?: { readonly title: string; readonly description: string };
    readonly tags?: readonly string[];
  };
}
export class ReviewViewError extends Error {
  constructor() {
    super("REVIEW_VIEW_INVALID");
    this.name = "ReviewViewError";
  }
}
const fail = (): never => {
  throw new ReviewViewError();
};
const fieldOrder: readonly ListingField[] = [
  "title",
  "descriptionHtml",
  "seo.title",
  "seo.description",
  "tags",
];
function parseSnapshot(text: string | null, productId: string): Snapshot | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail();
  }
  const s = value as Snapshot;
  if (
    !s ||
    typeof s !== "object" ||
    s.productId !== productId ||
    typeof s.title !== "string" ||
    typeof s.descriptionHtml !== "string" ||
    !s.seo ||
    !(s.seo.title === null || typeof s.seo.title === "string") ||
    !(s.seo.description === null || typeof s.seo.description === "string") ||
    !Array.isArray(s.tags) ||
    !s.tags.every((t) => typeof t === "string")
  )
    return fail();
  return s;
}
function before(s: Snapshot | null, field: ListingField): string | readonly string[] | null {
  if (s === null) return null;
  switch (field) {
    case "title":
      return s.title;
    case "descriptionHtml":
      return s.descriptionHtml;
    case "seo.title":
      return s.seo.title;
    case "seo.description":
      return s.seo.description;
    case "tags":
      return [...s.tags];
  }
}
function after(item: Item, field: ListingField): string | readonly string[] {
  const set = item.set;
  const value =
    field === "title"
      ? set.title
      : field === "descriptionHtml"
        ? set.descriptionHtml
        : field === "seo.title"
          ? set.seo?.title
          : field === "seo.description"
            ? set.seo?.description
            : set.tags;
  if (value === undefined) return fail();
  return typeof value === "string" ? value : [...value];
}
const fold = (tag: string) => tag.trim().toLocaleLowerCase("en-US");
function parseFlags(text: string | null | undefined): ReviewFlags | null {
  if (text === null || text === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail();
  }
  const keys = ["newEmails", "newPhones", "newUrls", "tagsAdded", "tagsRemoved"];
  const v = value as Record<string, unknown>;
  if (
    !v ||
    typeof v !== "object" ||
    Object.keys(v).sort().join(",") !== keys.join(",") ||
    !keys.every((k) => Number.isSafeInteger(v[k]) && (v[k] as number) >= 0)
  )
    return fail();
  return Object.freeze({
    newUrls: v.newUrls as number,
    newEmails: v.newEmails as number,
    newPhones: v.newPhones as number,
    tagsAdded: v.tagsAdded as number,
    tagsRemoved: v.tagsRemoved as number,
  });
}

/**
 * The review of every target of `proposal` (the root, or a derived proposal, whose targets map
 * to root indexes through derivedFrom.selectedTargetIndexes). `sources` are the root's, by
 * root index; `flags` are the drafts' reviewer flags by product id. Throws ReviewViewError on
 * any record that does not match (a server fault, never a partial view).
 */
export function buildProductReviews(
  proposal: Current_Proposal,
  parameters: unknown,
  sources: readonly ReviewSource[],
  flags: ReadonlyMap<string, string | null>,
): readonly ProductReview[] {
  const items = (parameters as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return fail();
  const selected = proposal.derivedFrom?.selectedTargetIndexes ?? null;
  return Object.freeze(
    proposal.targets.map((target, i) => {
      const root = selected === null ? i : selected[i]!;
      const productId = target.resource.id;
      const item = (items as Item[]).find((x) => x && x.targetIndex === root);
      const source = sources.find((s) => s.targetIndex === root);
      if (!item || item.productId !== productId || !source || source.productId !== productId)
        return fail();
      const snapshot = source.state === "available" ? parseSnapshot(source.snapshot, productId) : null;
      const fields = fieldOrder.filter((f) => (target.fields as readonly string[]).includes(f));
      if (fields.length !== target.fields.length) return fail();
      const changes = fields.map((field) =>
        Object.freeze({ field, before: before(snapshot, field), after: after(item, field) }),
      );
      let tags: ProductReview["tags"] = null;
      if (fields.includes("tags")) {
        const next = after(item, "tags") as readonly string[];
        const prev = snapshot ? [...snapshot.tags] : null;
        if (prev !== null) {
          const was = new Set(prev.map(fold));
          const now = new Set(next.map(fold));
          tags = Object.freeze({
            added: Object.freeze(next.filter((t) => !was.has(fold(t)))),
            removed: Object.freeze(prev.filter((t) => !now.has(fold(t)))),
          });
        }
      }
      return Object.freeze({
        targetIndex: root,
        productId,
        source: source.state,
        changes: Object.freeze(changes),
        tags,
        flags: parseFlags(flags.get(productId)),
      });
    }),
  );
}
