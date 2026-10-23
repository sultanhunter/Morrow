import { canonicalJson } from "../digest.js";
import { sanitizeListingHtml } from "./html.js";
import type { ListingFieldsRead } from "./listing-canonical.js";

// The gateway's read-back comparison (v1 PR 3; spine §8). Pure and dependency-light, shared by
// the broker (which compares) and the tests. For each field the apply sent:
//   * approved: the read-back equals the approved value under the canonical comparison, which
//     admits only what Shopify is known to do to a write: trim strings, treat a missing SEO
//     value as "", reorder or re-case tags (a tag set compared case-folded), and reformat the
//     description's HTML (sanitised to the listing allowlist, whitespace runs collapsed and
//     whitespace beside tags dropped);
//   * source: otherwise, the read-back equals the product as drafted, exactly as Shopify
//     returned it then (raw: null is not "");
//   * other: anything else.
// Approved wins when a value equals both. Strictly fail-safe: whatever the comparison cannot
// prove equal is not approved, so an unknown reformatting leaves the operation uncertain,
// never verified.

export type ListingFieldPath =
  | "descriptionHtml"
  | "seo.description"
  | "seo.title"
  | "tags"
  | "title";
export type FieldVerdict = "approved" | "source" | "other";
export type ReadbackVerdict = "approved" | "source" | "mixed";
export interface ApprovedSet {
  readonly title?: string;
  readonly descriptionHtml?: string;
  readonly seo?: { readonly title: string; readonly description: string };
  readonly tags?: readonly string[];
}
const fieldPaths: readonly string[] = [
  "descriptionHtml",
  "seo.description",
  "seo.title",
  "tags",
  "title",
];

function rawValue(p: ListingFieldsRead, field: ListingFieldPath): unknown {
  switch (field) {
    case "title":
      return p.title;
    case "descriptionHtml":
      return p.descriptionHtml;
    case "seo.title":
      return p.seo.title;
    case "seo.description":
      return p.seo.description;
    case "tags":
      return [...p.tags];
  }
}
function approvedValue(set: ApprovedSet, field: ListingFieldPath): unknown {
  switch (field) {
    case "title":
      return set.title;
    case "descriptionHtml":
      return set.descriptionHtml;
    case "seo.title":
      return set.seo?.title;
    case "seo.description":
      return set.seo?.description;
    case "tags":
      return set.tags === undefined ? undefined : [...set.tags];
  }
}
const text = (value: unknown): string | null =>
  value === null ? "" : typeof value === "string" ? value.trim() : null;
const tagSet = (value: unknown): string | null => {
  if (!Array.isArray(value) || !value.every((t) => typeof t === "string")) return null;
  const folded = [
    ...new Set(
      (value as string[]).map((t) => t.trim().toLocaleLowerCase("en-US")).filter((t) => t !== ""),
    ),
  ].sort();
  return JSON.stringify(folded);
};
const html = (value: unknown): string | null => {
  if (value === null) return "";
  if (typeof value !== "string") return null;
  try {
    return sanitizeListingHtml(value)
      .replace(/\s+/g, " ")
      .replace(/\s*(<[^>]+>)\s*/g, "$1")
      .trim();
  } catch {
    return null;
  }
};
/** The canonical form a field is compared in, or null when it cannot be formed (never equal). */
export function normalisedValue(field: ListingFieldPath, value: unknown): string | null {
  if (field === "tags") return tagSet(value);
  if (field === "descriptionHtml") return html(value);
  return text(value);
}

/**
 * The per-field verdicts and the overall verdict of one read-back. `source` is the product as
 * drafted (null once its snapshot is gone: then nothing is `source`). Throws on a field outside
 * the listing fields or a set missing a sent field (a broken caller, never a verdict).
 */
export function readbackVerdicts(
  readback: ListingFieldsRead,
  approved: ApprovedSet,
  source: ListingFieldsRead | null,
  fields: readonly string[],
): { readonly fields: Readonly<Record<string, FieldVerdict>>; readonly verdict: ReadbackVerdict } {
  if (fields.length < 1 || !fields.every((f) => fieldPaths.includes(f)))
    throw Error("LISTING_COMPARE_FIELDS_INVALID");
  const verdicts: Record<string, FieldVerdict> = {};
  for (const name of fields) {
    const field = name as ListingFieldPath;
    const want = approvedValue(approved, field);
    if (want === undefined) throw Error("LISTING_COMPARE_FIELDS_INVALID");
    const got = rawValue(readback, field);
    const normalisedGot = normalisedValue(field, got);
    const normalisedWant = normalisedValue(field, want);
    if (normalisedGot !== null && normalisedWant !== null && normalisedGot === normalisedWant)
      verdicts[field] = "approved";
    else if (source !== null && canonicalJson(got) === canonicalJson(rawValue(source, field)))
      verdicts[field] = "source";
    else verdicts[field] = "other";
  }
  const values = Object.values(verdicts);
  const verdict: ReadbackVerdict = values.every((v) => v === "approved")
    ? "approved"
    : values.every((v) => v === "source")
      ? "source"
      : "mixed";
  return Object.freeze({ fields: Object.freeze(verdicts), verdict });
}
