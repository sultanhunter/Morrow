// The listing HTML sanitiser and serialiser (M3 PR-2; mvp-architecture §2 step 8 and §8).
// Pure and dependency-free, so the orchestrator and the readback comparison (M4) use the
// same code. Model output and store content are untrusted: the output keeps only the
// allowlisted elements p, br, strong, em, ul, ol, li and h2-h4, with no attribute at all, so
// no link, image, script, style or event handler survives. Text is decoded once and
// re-escaped; comments, doctype and processing instructions are dropped; the content of
// script-like elements is dropped with them; any other element is unwrapped (its text kept).
// Unclosed allowlisted elements are closed at the end and stray closing tags ignored, so the
// output is balanced and serialising it again changes nothing.

const allowed: ReadonlySet<string> = new Set([
  "p",
  "br",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
]);
const voidElements: ReadonlySet<string> = new Set(["br"]);
// Elements whose content is never text for a listing: dropped with everything inside.
const dropped: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "svg",
  "math",
  "noscript",
  "textarea",
  "title",
  "head",
  "select",
  "option",
  "frameset",
  "frame",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
]);
const named: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
});

/** Decodes the character references of one text run (named, decimal and hex). */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/g,
    (whole, ref: string) => {
      if (ref[0] === "#") {
        const code =
          ref[1] === "x" || ref[1] === "X"
            ? parseInt(ref.slice(2), 16)
            : parseInt(ref.slice(1), 10);
        if (
          !Number.isSafeInteger(code) ||
          code < 1 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        )
          return "�";
        return String.fromCodePoint(code);
      }
      return Object.hasOwn(named, ref.toLowerCase()) ? named[ref.toLowerCase()]! : whole;
    },
  );
}
const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Sanitises one HTML fragment to the listing allowlist and serialises it canonically. */
export function sanitizeListingHtml(input: string): string {
  if (typeof input !== "string") throw Error("LISTING_HTML_INVALID");
  let out = "";
  const stack: string[] = [];
  let skip: string | null = null;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      if (skip === null) out += escapeText(decodeEntities(input.slice(i)));
      break;
    }
    if (lt > i && skip === null) out += escapeText(decodeEntities(input.slice(i, lt)));
    // Comments, doctype, CDATA and processing instructions: dropped whole.
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input[lt + 1] === "!" || input[lt + 1] === "?") {
      const end = input.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const match = /^<(\/?)([A-Za-z][A-Za-z0-9-]{0,31})((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(
      input.slice(lt, lt + 4096),
    );
    if (!match) {
      // A lone "<" is text.
      if (skip === null) out += "&lt;";
      i = lt + 1;
      continue;
    }
    i = lt + match[0].length;
    const closing = match[1] === "/";
    const name = match[2]!.toLowerCase();
    if (skip !== null) {
      if (closing && name === skip) skip = null;
      continue;
    }
    if (dropped.has(name)) {
      if (!closing && !/\/\s*$/.test(match[3]!)) skip = name;
      continue;
    }
    if (!allowed.has(name)) continue;
    if (voidElements.has(name)) {
      if (!closing) out += "<" + name + ">";
      continue;
    }
    if (!closing) {
      out += "<" + name + ">";
      stack.push(name);
      continue;
    }
    const at = stack.lastIndexOf(name);
    if (at === -1) continue;
    while (stack.length > at) out += "</" + stack.pop()! + ">";
  }
  while (stack.length) out += "</" + stack.pop()! + ">";
  return out;
}

/** The text of a sanitised fragment (tags removed, entities decoded), for flags and no-ops. */
export function listingHtmlText(html: string): string {
  return decodeEntities(sanitizeListingHtml(html).replace(/<[^>]*>/g, " "));
}
