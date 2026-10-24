import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { canonicalJson } from "../digest.js";
import { listingHtmlText, sanitizeListingHtml } from "./html.js";
import { listingSnapshotText } from "./listing-canonical.js";

// The Listings specialist's code checks (M3 PR-2; mvp-architecture §2 step 8; ADR-0022 items
// 2, 10 and 13): the model is untrusted, so everything that decides what a draft may change
// is here, outside any prompt (build-plan invariant 13).
//   * The model answers in ListingDraft_v1 (every field present and nullable). The nulls are
//     dropped and the result must be ListingDraft@1 (the full contract validator) naming the
//     requested product; another product id is product_mismatch.
//   * Only the run's fields are kept; the HTML is sanitised to the allowlist; tags are
//     trimmed and de-duplicated case-insensitively; every bound (title 255 characters,
//     description HTML 10,000 bytes after sanitising, SEO title 70 and description 320, at
//     most 50 tags of 64 characters) is rechecked; a change equal to the snapshot under the
//     canonical comparison (spine §8) is dropped. Nothing left to change is a validation
//     failure: an unchanged product earns no credit.
//   * The reviewer flags count the URLs, email addresses and phone numbers the draft adds
//     that the snapshot never had, and the tags added and removed (tags drive collections and
//     automations); the review screen shows them. Counts only, no content.

export const listingFields = Object.freeze([
  "descriptionHtml",
  "seo.description",
  "seo.title",
  "tags",
  "title",
] as const);
export type ListingField = (typeof listingFields)[number];
export interface ListingSnapshot {
  readonly productId: string;
  readonly title: string;
  readonly descriptionHtml: string;
  readonly seo: { readonly title: string | null; readonly description: string | null };
  readonly tags: readonly string[];
}
export interface ListingSet {
  readonly title?: string;
  readonly descriptionHtml?: string;
  readonly seo?: { readonly title: string; readonly description: string };
  readonly tags?: readonly string[];
}
export interface DraftFlags {
  readonly newUrls: number;
  readonly newEmails: number;
  readonly newPhones: number;
  readonly tagsAdded: number;
  readonly tagsRemoved: number;
}
export type DraftCheck =
  | {
      readonly ok: true;
      readonly set: ListingSet;
      /** The changed fields, sorted (both SEO fields when the SEO pair changed). */
      readonly fields: readonly ListingField[];
      /** The canonical text of `set`: the CatalogContentChangeSet@1 item's set. */
      readonly setCanonical: string;
      readonly flags: DraftFlags;
    }
  | { readonly ok: false; readonly code: "validation" | "product_mismatch" };

export const draftLimits = Object.freeze({
  titleChars: 255,
  descriptionBytes: 10_000,
  seoTitleChars: 70,
  seoDescriptionChars: 320,
  tags: 50,
  tagChars: 64,
  setBytes: 16_000,
});
const bytes = (text: string) => new TextEncoder().encode(text).length;
const chars = (text: string) => [...text].length;
const fail = (code: "validation" | "product_mismatch" = "validation") =>
  Object.freeze({ ok: false as const, code });

/** Whether a field list is a valid run field list: 1..5 distinct listing fields, sorted, with the SEO pair. */
export function runFieldsValid(fields: unknown): fields is readonly ListingField[] {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 5) return false;
  if (
    !fields.every((f) => typeof f === "string" && (listingFields as readonly string[]).includes(f))
  )
    return false;
  const sorted = [...new Set(fields as string[])].sort();
  if (sorted.length !== fields.length || sorted.some((f, i) => f !== fields[i])) return false;
  return fields.includes("seo.title") === fields.includes("seo.description");
}

/** The largest canonical snapshot a run stores (product_snapshots holds at most 64 KiB). */
export const snapshotMaxBytes = 65_536;
// The one canonical form (listing-canonical.ts), shared with the gateway's pre-send check. A
// snapshot here is already de-duplicated (readSnapshot), so its text is unchanged by it.
const snapshotText = (snapshot: ListingSnapshot) => listingSnapshotText(snapshot);
/**
 * A product as M2 PR-3's read returned it, with exact duplicate tags dropped (the first kept):
 * the read's closed result does not require unique tags, ListingSnapshot@1 does, and Shopify
 * keeps a product's tags unique, so a duplicate carries nothing.
 */
export function readSnapshot(product: ListingSnapshot): ListingSnapshot {
  return Object.freeze({
    productId: product.productId,
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    seo: Object.freeze({ title: product.seo.title, description: product.seo.description }),
    tags: Object.freeze([...new Set(product.tags)]),
  });
}
/**
 * The canonical byte size of a product as read, before any schema check: the read admits
 * longer text than ListingSnapshot@1 (a 196,608-byte description), so a product over
 * snapshotMaxBytes is too_large, never read_failed. Within the bound no string can exceed the
 * schema's 65,536 characters.
 */
export function snapshotBytes(snapshot: ListingSnapshot): number {
  return bytes(snapshotText(snapshot));
}
/** The canonical snapshot text of one product as read (its digest is the expected source revision). */
export function snapshotCanonical(snapshot: ListingSnapshot): string {
  if (!validateCurrentDefinition("ListingSnapshot", snapshot))
    throw Error("LISTING_SNAPSHOT_INVALID");
  return snapshotText(snapshot);
}

const fold = (tag: string) => tag.trim().toLocaleLowerCase("en-US");
function normaliseTags(tags: readonly string[]): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "") continue;
    if (chars(tag) > draftLimits.tagChars) return null;
    if (seen.has(fold(tag))) continue;
    seen.add(fold(tag));
    out.push(tag);
  }
  return out.length > draftLimits.tags ? null : out;
}
const sameTags = (a: readonly string[], b: readonly string[]) => {
  const x = [...new Set(a.map(fold).filter((t) => t !== ""))].sort();
  const y = [...new Set(b.map(fold).filter((t) => t !== ""))].sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
};
const sameText = (a: string | null, b: string | null) => (a ?? "").trim() === (b ?? "").trim();

// Contact and link patterns of the reviewer flags (spine §7 "contact and URL flags").
const urlPattern =
  /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|shop|store|app|dev|uk|us|ca|au|de|fr)\b(?:\/[^\s<>"']*)?/gi;
const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const phonePattern = /(?:\+?\d[\s().-]*){7,15}\d/g;
const found = (pattern: RegExp, text: string) =>
  new Set([...text.matchAll(pattern)].map((m) => m[0].toLowerCase().replace(/[\s().-]/g, "")));
function added(pattern: RegExp, draft: string, source: string): number {
  const before = found(pattern, source);
  let count = 0;
  for (const value of found(pattern, draft)) if (!before.has(value)) count += 1;
  return Math.min(count, 999);
}

/**
 * Checks one model output against the requested product, its snapshot and the run's
 * fields. `output` is ModelResult@1's structurally checked output (ListingDraft_v1, nulls
 * allowed); anything else fails.
 */
export function checkDraft(
  output: unknown,
  productId: string,
  snapshot: ListingSnapshot,
  runFields: readonly ListingField[],
): DraftCheck {
  if (!output || typeof output !== "object" || Array.isArray(output)) return fail();
  // ListingDraft_v1 -> ListingDraft@1: the nullable fields that are null are absent.
  const draft: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>))
    if (value !== null) draft[key] = value;
  if (!validateCurrentDefinition("ListingDraft", draft)) return fail();
  if (draft.productId !== productId || snapshot.productId !== productId)
    return fail("product_mismatch");
  if (!runFieldsValid(runFields)) throw Error("LISTING_FIELDS_INVALID");
  const want = new Set<string>(runFields);
  const set: {
    title?: string;
    descriptionHtml?: string;
    seo?: { title: string; description: string };
    tags?: string[];
  } = {};
  if (want.has("title") && typeof draft.title === "string") {
    const title = draft.title.trim();
    if (title === "" || chars(title) > draftLimits.titleChars) return fail();
    if (!sameText(title, snapshot.title)) set.title = title;
  }
  if (want.has("descriptionHtml") && typeof draft.descriptionHtml === "string") {
    const html = sanitizeListingHtml(draft.descriptionHtml).trim();
    if (bytes(html) > draftLimits.descriptionBytes) return fail();
    if (html !== sanitizeListingHtml(snapshot.descriptionHtml).trim()) set.descriptionHtml = html;
  }
  if (want.has("seo.title") && draft.seo && typeof draft.seo === "object") {
    const seo = draft.seo as { title: string; description: string };
    const title = seo.title.trim();
    const description = seo.description.trim();
    if (
      chars(title) > draftLimits.seoTitleChars ||
      chars(description) > draftLimits.seoDescriptionChars
    )
      return fail();
    if (!sameText(title, snapshot.seo.title) || !sameText(description, snapshot.seo.description))
      set.seo = { title, description };
  }
  if (want.has("tags") && Array.isArray(draft.tags)) {
    const tags = normaliseTags(draft.tags as string[]);
    if (tags === null) return fail();
    if (!sameTags(tags, snapshot.tags)) set.tags = tags;
  }
  const fields = (Object.keys(set) as (keyof ListingSet)[])
    .flatMap((key) => (key === "seo" ? ["seo.description", "seo.title"] : [key]))
    .sort() as ListingField[];
  if (fields.length === 0) return fail();
  if (!validateCurrentDefinition("CatalogContentSet", set)) return fail();
  const setCanonical = canonicalJson(set);
  if (bytes(setCanonical) > draftLimits.setBytes) return fail();
  const draftText = [
    set.title ?? "",
    set.descriptionHtml ? listingHtmlText(set.descriptionHtml) : "",
    set.seo?.title ?? "",
    set.seo?.description ?? "",
    ...(set.tags ?? []),
  ].join("\n");
  const sourceText = [
    snapshot.title,
    listingHtmlText(snapshot.descriptionHtml),
    snapshot.seo.title ?? "",
    snapshot.seo.description ?? "",
    ...snapshot.tags,
  ].join("\n");
  const before = new Set(snapshot.tags.map(fold));
  const after = new Set((set.tags ?? snapshot.tags).map(fold));
  const flags: DraftFlags = Object.freeze({
    // An email address's domain is not counted again as a link.
    newUrls: added(
      urlPattern,
      draftText.replace(emailPattern, " "),
      sourceText.replace(emailPattern, " "),
    ),
    newEmails: added(emailPattern, draftText, sourceText),
    newPhones: added(phonePattern, draftText, sourceText),
    tagsAdded: Math.min([...after].filter((t) => !before.has(t)).length, 999),
    tagsRemoved: Math.min([...before].filter((t) => !after.has(t)).length, 999),
  });
  return Object.freeze({
    ok: true as const,
    set: Object.freeze(set),
    fields: Object.freeze(fields),
    setCanonical,
    flags,
  });
}
