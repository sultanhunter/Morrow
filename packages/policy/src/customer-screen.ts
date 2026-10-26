import type { Current_CustomerDataKind, Current_CustomerScreenRefusal } from "@morrow/contracts";

// The customer identifier screen (H9a; ADR-0041 item 31, ADR-0040 item 2; owner question 23 of
// OD-2026-10-26-7; docs/briefs/h9a-customer-identifier-screen.md). Until P09.T05's deletion and
// privacy path exists, Morrow keeps no customer details (CLAUDE.md). This is the one screen in
// code, outside any prompt, that keeps them out:
//   * ADR-0040's post command runs it on the person's text before anything is stored
//     (screenPost); a match is refused as `not_started: customer_data` with
//     customerDataSafeMessage, and nothing of the text is stored, logged or sent.
//   * Every text a model writes that Morrow stores passes it before commit (screenModelWritten,
//     modelWrittenTextKinds): a match is refused (`customer_data`), and a flagged compaction
//     summary is dropped for the fallback reset on code facts.
//   * Order numbers and order GIDs are not customer data (CLAUDE.md) and pass.
// What it finds (CustomerDataKind@v1.1, content-free): email addresses, also obfuscated
// (bracketed "(at)" and "(dot)", HTML or percent escapes, full-width or zero-width characters),
// and spaced or written-out forms with an address-like local part or a personal mail provider;
// phone numbers; street-address patterns (a house number with a street, a PO box, a unit and
// street pair, a postcode or ZIP); Shopify customer ids (GIDs plain, percent-encoded or
// base64, admin links, `customer:<id>`, a customer id after the word "customer"); and,
// through the broker's keyed list, looser email forms whose keyed digest is a listed customer
// email.
// What it cannot find: a customer's name typed as free text ("Jane Smith asked for a refund")
// matches no pattern, and Morrow holds no list of names to compare with. The composer's standing
// line and message redaction narrow that gap; the owner decides the rest (ADR-0041 item 31).
// What it also refuses: the shop's own contact details (its support address, its phone, its
// shop address), which no pattern can tell from a customer's; owner question 23 approved the
// screen for every email, phone and street address.
// Pure and synchronous apart from the list port: no I/O, no node:* import, no model. Every
// pattern is linear in the text (bounded quantifiers, fixed alternations), and the verdict names
// kinds only, never the text or what matched.

export type CustomerDataKind = Current_CustomerDataKind;
export type CustomerScreenRefusal = Current_CustomerScreenRefusal;

/** CustomerDataKind@v1.1's values, in the contract's order. */
export const customerDataKinds: readonly CustomerDataKind[] = Object.freeze([
  "email",
  "phone",
  "street_address",
  "customer_gid",
  "listed_email",
]);

/** The bounds the screen holds (callers bound their own texts well below them). */
export const customerScreenLimits = Object.freeze({
  /** Characters in one text; a longer one is a caller defect (CUSTOMER_SCREEN_TEXT_TOO_LONG). */
  textChars: 1_048_576,
  /** Texts in one call (a tool input's or a structured output's strings and keys). */
  texts: 4096,
  /** Characters across one call's texts. */
  totalChars: 4_194_304,
  /** Nesting depth of a structured value (stringsOf). */
  depth: 16,
  /** Distinct looser email forms checked against the keyed list in one call. */
  listCandidates: 32,
  /** Base64 tokens decoded while looking for an encoded customer GID. */
  base64Tokens: 256,
});

/**
 * The refusal's plain copy (ADR-0040 item 2, ADR-0041 item 31, exactly): the post route's safe
 * message for `not_started: customer_data`, and the composer's notice.
 */
export const customerDataSafeMessage =
  "Morrow can't keep customer details yet. Remove them and send again.";
/**
 * The standing line under the composer of every conversation with an agent (ADR-0041 item 31).
 * It names what the screen cannot detect: a customer's name.
 */
export const customerDetailsStandingLine = "Don't include customers' names or contact details.";

/** The screen's verdict on text: content-free, kinds sorted in the contract's order. */
export type CustomerScreenVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "customer_data";
      readonly kinds: readonly CustomerDataKind[];
    };
/** With the keyed list: an unanswerable list fails closed, and nothing is stored. */
export type ListedCustomerScreenVerdict =
  | CustomerScreenVerdict
  | { readonly ok: false; readonly code: "screen_unavailable" };

/**
 * The keyed customer email list. `customers/redact` today keeps a keyed digest of the customer
 * id only (apps/broker/src/shopify.ts, `morrow.shopify.customer.v1|<id>`, the app secret as
 * key); P09.T05 adds the keyed digest of the customer's email, under a key that stays in the
 * broker vault (ADR-0031 item 3). The screen hands this port the digest inputs of the looser
 * email forms it found (customerEmailDigestInput); the broker computes each keyed digest and
 * answers one boolean. Inputs reach only the broker, the list holds keyed digests only, and
 * "unavailable" (or a throw) fails the screen closed (screen_unavailable). Before P09.T05 Morrow
 * holds no customer email, so the list is empty (noListedCustomerEmails).
 */
export interface CustomerEmailDigestList {
  anyListed(inputs: readonly string[]): Promise<boolean | "unavailable">;
}
/** The list before P09.T05: no customer email has entered Morrow, so none is listed. */
export const noListedCustomerEmails: CustomerEmailDigestList = Object.freeze({
  anyListed: async () => false,
});

/**
 * The text a keyed email digest is computed over (the broker's HMAC input, domain-separated
 * and versioned): NFKC, lower case, a `+tag` dropped from the local part, the domain without a
 * trailing dot. The list's writer (P09.T05) and this screen use the same function. Null when it
 * is not an email address.
 */
export function customerEmailDigestInput(email: string): string | null {
  if (typeof email !== "string" || email.length > 320) return null;
  const e = email.normalize("NFKC").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  let local = e.slice(0, at);
  const domain = e.slice(at + 1).replace(/\.$/u, "");
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (!/^[\p{L}\p{N}._%-]{1,64}$/u.test(local) || !domainShape.test(domain)) return null;
  return "morrow.customer-email.v1|" + local + "@" + domain;
}

// ---------------------------------------------------------------------------------------------
// The scan copy. Only the screen reads it; it is never stored. NFKC folds full-width and
// compatibility forms (＠, ﹫, full-width digits and letters, no-break spaces); format characters
// (zero-width spaces and joiners, bidi controls, soft hyphens, variation selectors, fillers) are
// dropped; HTML character references and percent escapes of the characters an address or id
// needs are decoded, and the result is folded again (an escaped full-width at sign is still an
// at sign), up to three times; every decimal digit becomes its ASCII digit; every dash becomes "-"; and bracketed
// "(at)" and "(dot)" become "@" and ".".
const formatCharacters = /[\p{Cf}͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ\u{E0100}-\u{E01EF}]/gu;
const dashes = /[‐-―−﹘﹣－]/gu;
const namedReferences: Readonly<Record<string, string>> = Object.freeze({
  commat: "@",
  period: ".",
  colon: ":",
  sol: "/",
  nbsp: " ",
  amp: "&",
  plus: "+",
  num: "#",
  lpar: "(",
  rpar: ")",
});
function decodeReference(_: string, body: string): string {
  if (body[0] === "#") {
    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isInteger(code) &&
      code > 0 &&
      code <= 0x10ffff &&
      (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : " ";
  }
  return namedReferences[body.toLowerCase()] ?? "&" + body + ";";
}
const htmlReference = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/gu;
const percentEscapes: Readonly<Record<string, string>> = Object.freeze({
  "40": "@",
  "2e": ".",
  "3a": ":",
  "2f": "/",
  "20": " ",
  "2b": "+",
  "23": "#",
  "28": "(",
  "29": ")",
});
const percentEscape = /%(40|2[eEfF0bB389]|3[aA])/gu;
// Decimal digits of every script count as digits (an Urdu or Arabic phone number is a phone
// number): NFKC folds the compatibility ones, and each other decimal digit becomes its value,
// read from its place in its script's run of ten.
const otherDigit = /(?![0-9])\p{Nd}/gu;
const decimalDigit = /^\p{Nd}$/u;
function digitValue(c: string): string {
  let cp = c.codePointAt(0)!;
  let value = 0;
  while (value < 9 && decimalDigit.test(String.fromCodePoint(cp - 1))) {
    cp -= 1;
    value += 1;
  }
  return String(value);
}
const bracketedAt = /[ \t]*[([{<][ \t]*(?:at|@)[ \t]*[)\]}>][ \t]*/giu;
const bracketedDot = /[ \t]*[([{<][ \t]*(?:dot|\.)[ \t]*[)\]}>][ \t]*/giu;
const fold = (text: string) => text.normalize("NFKC").replace(formatCharacters, "");
const unescaped = (text: string) =>
  text
    .replace(htmlReference, decodeReference)
    .replace(percentEscape, (_, hex: string) => percentEscapes[hex.toLowerCase()] ?? "");
// Escapes are decoded up to three times ("&amp;#64;" is an at sign escaped twice).
const decodePasses = 3;
function scanCopy(text: string): string {
  let current = fold(text);
  for (let pass = 0; pass < decodePasses && /[&%]/u.test(current); pass += 1) {
    const next = fold(unescaped(current));
    if (next === current) break;
    current = next;
  }
  return current
    .replace(otherDigit, digitValue)
    .replace(dashes, "-")
    .replace(bracketedAt, "@")
    .replace(bracketedDot, ".");
}

// ---------------------------------------------------------------------------------------------
// Email addresses.
const label = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?";
const domainShape = new RegExp(`^(?:${label}\\.)+\\p{L}{2,24}$`, "u");
const emailPattern = new RegExp(
  `(?<![\\p{L}\\p{N}._%+-])([\\p{L}\\p{N}._%+-]{1,64})@((?:${label}\\.)+(\\p{L}{2,24}))(?![\\p{L}\\p{N}-])`,
  "gu",
);
// "name@2x.png" is an image, not an address.
const fileExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "heic",
  "bmp",
  "tif",
  "tiff",
  "ico",
  "pdf",
  "js",
  "mjs",
  "css",
  "html",
  "htm",
  "json",
  "txt",
  "csv",
  "tsv",
  "xml",
  "xls",
  "xlsx",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "mp3",
  "mp4",
  "mov",
  "webm",
  "wav",
  "liquid",
  "md",
]);
// Personal mail providers: a spaced or written-out "name at gmail dot com" is an address, and
// "name@gmail" without its top-level domain is one too.
const mailProviders: Readonly<Record<string, readonly string[]>> = Object.freeze({
  gmail: ["gmail.com"],
  googlemail: ["googlemail.com"],
  yahoo: ["yahoo.com"],
  ymail: ["ymail.com"],
  hotmail: ["hotmail.com", "hotmail.co.uk"],
  outlook: ["outlook.com"],
  live: ["live.com"],
  msn: ["msn.com"],
  icloud: ["icloud.com"],
  me: ["me.com"],
  mac: ["mac.com"],
  aol: ["aol.com"],
  proton: ["proton.me"],
  protonmail: ["protonmail.com"],
  gmx: ["gmx.com", "gmx.de"],
  yandex: ["yandex.com", "yandex.ru"],
  zoho: ["zoho.com"],
  hey: ["hey.com"],
  fastmail: ["fastmail.com"],
  qq: ["qq.com"],
  "163": ["163.com"],
  "126": ["126.com"],
  rediffmail: ["rediffmail.com"],
});
const providerNames = Object.keys(mailProviders).join("|");
// Top-level domains a written-out address may end with ("name at shop dot com").
const writtenTlds =
  "com|net|org|edu|gov|mil|int|info|biz|io|co|ai|app|dev|me|shop|store|online|site|xyz|email|" +
  "uk|us|ca|au|nz|ie|de|fr|es|it|nl|be|ch|at|se|no|dk|fi|pt|pl|cz|gr|ru|ua|tr|il|ae|sa|qa|kw|" +
  "bh|om|eg|ma|ng|ke|za|in|pk|bd|lk|np|my|sg|id|ph|th|vn|cn|jp|kr|tw|hk|br|mx|ar|cl|pe";
const looseLocal = "(?<![\\p{L}\\p{N}._%+-])([\\p{L}\\p{N}._%+-]{1,64})";
const looseDomain = `((?:${label}(?:[ \\t]?\\.[ \\t]?|[ \\t]+dot[ \\t]+))+)`;
// "name @ shop.com", "name@ shop . com": an at sign with spaces on either side.
const spacedEmail = new RegExp(
  `${looseLocal}(?:[ \\t]+@[ \\t]*|@[ \\t]+)${looseDomain}(\\p{L}{2,24})(?![\\p{L}\\p{N}-])`,
  "giu",
);
// "name at shop dot com", "name at shop.com".
const writtenEmail = new RegExp(
  `${looseLocal}[ \\t]+at[ \\t]+${looseDomain}(${writtenTlds})(?![\\p{L}\\p{N}-])`,
  "giu",
);
// "name@gmail", "name at gmail": a mail provider without its top-level domain.
const bareProvider = new RegExp(
  `${looseLocal}([ \\t]*@[ \\t]*|[ \\t]+at[ \\t]+)(${providerNames})(?![\\p{L}\\p{N}.@-])`,
  "giu",
);
// A local part with a dot, underscore or plus, or with letters and digits, reads as an address
// ("jane.doe at shop dot com", "jane99 @ shop.com"); a plain word ("find us at shop dot com") or
// a bare number ("sold 5 @ shop.com") may be a sentence, so only the keyed list decides it.
const addressLikeLocal = /[._+]|\p{L}.*[0-9]|[0-9].*\p{L}/u;

interface Findings {
  readonly kinds: Set<CustomerDataKind>;
  readonly candidates: Set<string>;
}

function looseForm(found: Findings, local: string, domainText: string, tld: string): void {
  const domain = (domainText + tld)
    .replace(/[ \t]+dot[ \t]+/giu, ".")
    .replace(/[ \t]/gu, "")
    .toLowerCase();
  if (fileExtensions.has(tld.toLowerCase())) return;
  if (addressLikeLocal.test(local) || Object.hasOwn(mailProviders, domain.split(".")[0]!))
    found.kinds.add("email");
  else addCandidate(found, local + "@" + domain);
}
function scanEmails(scan: string, found: Findings): void {
  const hasAt = scan.includes("@");
  const writtenAt = /[ \t]at[ \t]/iu.test(scan);
  if (hasAt) {
    for (const m of scan.matchAll(emailPattern))
      if (!fileExtensions.has(m[3]!.toLowerCase())) found.kinds.add("email");
    if (/[ \t]@|@[ \t]/u.test(scan))
      for (const m of scan.matchAll(spacedEmail)) looseForm(found, m[1]!, m[2]!, m[3]!);
  }
  if (writtenAt) for (const m of scan.matchAll(writtenEmail)) looseForm(found, m[1]!, m[2]!, m[3]!);
  if (hasAt || writtenAt)
    for (const m of scan.matchAll(bareProvider)) {
      const local = m[1]!;
      // "jane@gmail" is an address with its top-level domain dropped; "jane at gmail" and
      // "say hi @ me" may be sentences.
      if (m[2] === "@" || addressLikeLocal.test(local)) found.kinds.add("email");
      else
        for (const domain of mailProviders[m[3]!.toLowerCase()] ?? [])
          addCandidate(found, local + "@" + domain);
    }
}
function addCandidate(found: Findings, email: string): void {
  const input = customerEmailDigestInput(email);
  if (input !== null) found.candidates.add(input);
}

// ---------------------------------------------------------------------------------------------
// Shopify customer ids. Orders, products and every other GID pass.
const customerGidTypes =
  "Customer|CustomerAddress|MailingAddress|CustomerPaymentMethod|CustomerSegmentMember|CompanyContact";
const customerGid = new RegExp(
  `(?:gid:\\/\\/)?shopify\\/(?:${customerGidTypes})\\/[1-9][0-9]{0,19}(?![0-9])`,
  "iu",
);
const customerAdminLink =
  /(?:admin\.shopify\.com\/store\/[a-z0-9][a-z0-9-]{0,62}|\/admin(?:\/api\/[a-z0-9.-]{1,16})?)\/customers\/[1-9][0-9]{0,19}(?![0-9])/iu;
const customerRecordId = /(?<![\p{L}\p{N}_:])customer:[1-9][0-9]{0,19}(?![0-9])/iu;
// "customer 7234567890123", "customer id: 7234567890123", "customer_id=...", "customerId": a
// customer's numeric id (seven digits or more; Shopify's are thirteen today) after the word.
const customerWordId =
  /(?<![\p{L}\p{N}])customer(?:[ \t_-]?(?:id|no\.?|number|#))?["']?[ \t]{0,2}[:=#]?[ \t]{0,2}["']?[ \t]{0,2}[1-9][0-9]{6,19}(?![0-9])/iu;
// base64("gid://") is "Z2lkOi8v": only such tokens are decoded.
const encodedGid = /Z2lkOi8v[A-Za-z0-9+/_-]{8,200}={0,2}/gu;

function scanCustomerIds(scan: string, found: Findings): void {
  if (
    customerGid.test(scan) ||
    customerAdminLink.test(scan) ||
    customerRecordId.test(scan) ||
    customerWordId.test(scan)
  ) {
    found.kinds.add("customer_gid");
    return;
  }
  let decoded = 0;
  for (const m of scan.matchAll(encodedGid)) {
    if (++decoded > customerScreenLimits.base64Tokens) break;
    const token = m[0].replace(/-/gu, "+").replace(/_/gu, "/").replace(/=+$/u, "");
    const padded = token.slice(0, token.length - (token.length % 4 === 1 ? 1 : 0));
    let text: string;
    try {
      text = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    } catch {
      continue;
    }
    if (customerGid.test(text)) {
      found.kinds.add("customer_gid");
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The phone and address scans read a masked copy: links, GIDs, email addresses, Morrow record
// ids and ISO dates and times are blanked first (an order GID's 13 digits are an id, a date's
// digits a date), after the phone links among them (tel:, wa.me, WhatsApp's send link) are read.
const phoneLink =
  /\btel:[ \t]*(\+?[0-9][0-9 \t().-]{5,24}[0-9])|\bwa\.me\/\+?([0-9]{7,15})\b|\bwhatsapp\.com\/send\/?\?(?:[a-z_]+=[^&\s]*&)*phone=\+?([0-9]{7,15})\b/giu;
const maskPatterns: readonly RegExp[] = Object.freeze([
  /\b(?:https?:\/\/|www\.)[^\s<>"']{1,2048}/giu,
  /\bgid:\/\/[^\s<>"']{1,256}/giu,
  /[\p{L}\p{N}._%+-]{1,64}@[^\s<>"',;]{1,255}/gu,
  /\b(?:product|order|variant|collection|location|fulfillment|refund|line_item|inventory_item|draft_order):[0-9]{1,20}\b/giu,
  /\b[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?\b/gu,
  /\b[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\b/gu,
  /\b[0-9]{1,3}(?:\.[0-9]{1,3}){3}\b/gu,
]);
function maskedCopy(scan: string, found: Findings): string {
  for (const m of scan.matchAll(phoneLink)) {
    const digits = (m[1] ?? m[2] ?? m[3] ?? "").replace(/[^0-9]/gu, "");
    if (digits.length >= 7 && digits.length <= 15) found.kinds.add("phone");
  }
  let masked = scan;
  for (const pattern of maskPatterns) masked = masked.replace(pattern, (s) => " ".repeat(s.length));
  return masked;
}

// Phone numbers. A run of digits with phone separators, classified by its shape and the words
// right before it: a phone word ("phone", "call", "WhatsApp" ...) makes 7 to 15 digits a phone;
// an id or money word ("order", "SKU", "tracking", "Rs" ...) makes it not one; otherwise an
// international number (+ or 00) of 8 to 15 digits, a grouped number of 10 to 13 digits, or a
// bare national number (10 or 11 digits with a trunk 0, or a valid North American number).
const phoneRun =
  /(?<![\p{L}\p{N}_#$€£¥₹@/\\.,=+-])(\+|\b00)?[ \t]?(?:\([0-9]{1,5}\)|[0-9])(?:[ \t.()-]{0,3}[0-9]){6,16}(?![\p{L}\p{N}_])/gu;
const phoneWordBefore =
  /\b(?:phone|phones|tel|telephone|mobile|mob|cell|cellphone|whats ?app|call|sms|fax|ph|landline|contact|reach)\b[^\p{L}\p{N}]{0,4}(?:\p{L}{1,12}[^\p{L}\p{N}]{1,4}){0,2}$/iu;
const idWordBefore =
  /\b(?:order|orders|product|products|variant|sku|item|items|invoice|tracking|track|ref|reference|po|barcode|upc|ean|isbn|gtin|mpn|asin|id|code|batch|lot|serial|model|part|awb|consignment|shipment|parcel|receipt|transaction|txn|account|acct|rs|pkr|inr|usd|eur|gbp|aed|sar|rupees|dollars|qty|quantity|total|price|amount|revenue|sales|profit|cost|budget|spend|gmv|aov|views|visits)\b[^\p{L}\p{N}]{0,4}(?:(?:no|nr|num|number|id)\b[^\p{L}\p{N}]{0,4})?$/iu;
const unitAfter =
  /^[ \t]{0,2}(?:%|(?:units?|pcs|pieces?|items?|orders?|views?|visits?|customers?|sales|products?|usd|pkr|inr|eur|gbp|aed|sar|rs|rupees|dollars|times|days?|nights?)\b)/iu;
const nanp = (ten: string) => /^[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(ten);

function phoneShaped(match: string, before: string, after: string): boolean {
  const digits = match.replace(/[^0-9]/gu, "");
  const international = match.startsWith("+") || match.startsWith("00");
  const body = match.replace(/^(?:\+|00)/u, "");
  if (/\.[0-9]{1,2}$/u.test(match)) return false; // an amount with decimals
  const groups = body.split(/[ \t.()-]+/u).filter((g) => g !== "");
  if (groups.filter((g) => g.length === 1).length > 1) return false; // ISBN-like groups
  if (unitAfter.test(after)) return false;
  if (phoneWordBefore.test(before)) return digits.length >= 7 && digits.length <= 15;
  if (idWordBefore.test(before)) return false;
  if (international) {
    const n = match.startsWith("00") ? digits.length - 2 : digits.length;
    return n >= 8 && n <= 15;
  }
  if (digits.length < 10 || digits.length > 13) return false;
  if (groups.length > 1) return true;
  if (digits.length === 10) return digits.startsWith("0") ? digits[1] !== "0" : nanp(digits);
  if (digits.length === 11)
    return digits.startsWith("0") ? digits[1] !== "0" : digits[0] === "1" && nanp(digits.slice(1));
  return false;
}
function scanPhones(masked: string, found: Findings): void {
  if (!/[0-9]{3}/u.test(masked.replace(/[ \t.()-]/gu, ""))) return;
  for (const m of masked.matchAll(phoneRun)) {
    const at = m.index;
    const match = m[0].trimEnd();
    if (
      phoneShaped(
        match,
        masked.slice(Math.max(0, at - 40), at),
        masked.slice(at + m[0].length, at + m[0].length + 16),
      )
    ) {
      found.kinds.add("phone");
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Street addresses. Shapes, never a gazetteer: a house number, one to four street-name words and
// a street word ("12 Baker Street", "742 Evergreen Terrace", "1600 Pennsylvania Ave NW"); a
// number, a street type and a name ("10 rue de Rivoli"); a street type, a name and a number
// ("Calle Mayor 5", "Via Roma 12"); a compound street ("Hauptstraße 12", "Kerkstraat 5"); a unit
// and street pair ("House 12, Street 5", "Flat 4B, Block C"); a PO box; a postcode or ZIP in its
// place (a UK postcode area, a Canadian code, "Springfield, IL 62704", "zip 90210").
// Words that can be a street word or an ordinary noun ("Drive", "Court", "Place", "Way") count
// only in title case and never after the words that make them ordinary ("hard drive", "food
// court", "first place").
const anyCaseStreetWords = new Set([
  "street",
  "st",
  "avenue",
  "ave",
  "road",
  "rd",
  "boulevard",
  "blvd",
  "ln",
  "ct",
  "pl",
  "sq",
  "parkway",
  "pkwy",
  "highway",
  "hwy",
  "cres",
  "terr",
  "ter",
  "expressway",
  "expy",
  "freeway",
  "fwy",
  "turnpike",
  "tpke",
  "causeway",
  "cswy",
  "cir",
]);
const titleCaseStreetWords = new Set([
  "drive",
  "dr",
  "court",
  "place",
  "square",
  "terrace",
  "lane",
  "plaza",
  "way",
  "close",
  "row",
  "walk",
  "grove",
  "gardens",
  "mews",
  "hill",
  "circle",
  "crescent",
  "view",
  "trail",
  "path",
  "alley",
  "wharf",
  "quay",
  "parade",
  "esplanade",
  "embankment",
]);
const ordinaryBefore: Readonly<Record<string, readonly string[]>> = Object.freeze({
  drive: [
    "hard",
    "flash",
    "usb",
    "disk",
    "disc",
    "thumb",
    "test",
    "wheel",
    "ssd",
    "hdd",
    "state",
    "external",
    "internal",
    "optical",
    "pen",
    "cd",
    "dvd",
    "tape",
    "floppy",
    "network",
    "cloud",
    "google",
    "sex",
    "blood",
    "food",
    "fund",
    "sales",
    "membership",
    "recruitment",
  ],
  dr: ["hard", "test"],
  court: [
    "food",
    "tennis",
    "basketball",
    "supreme",
    "high",
    "district",
    "county",
    "federal",
    "appeals",
    "royal",
    "squash",
    "crown",
    "magistrates",
    "family",
    "small",
    "claims",
  ],
  place: [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "last",
    "market",
    "work",
    "meeting",
    "hiding",
    "fire",
    "birth",
    "happy",
    "safe",
    "right",
    "wrong",
    "same",
  ],
  square: ["town", "public", "village"],
  lane: [
    "memory",
    "fast",
    "slow",
    "bus",
    "bike",
    "cycle",
    "express",
    "passing",
    "inside",
    "outside",
  ],
  way: [
    "one",
    "two",
    "three",
    "no",
    "any",
    "some",
    "every",
    "other",
    "right",
    "wrong",
    "best",
    "easy",
    "hard",
    "half",
    "long",
    "only",
    "same",
    "better",
    "fastest",
    "quickest",
    "simplest",
  ],
  row: ["front", "back", "death", "skid", "first", "second", "last", "top", "bottom"],
  walk: ["cake", "cat", "board", "moon", "space", "sky", "dog"],
  view: ["point", "preview", "overview", "review", "world", "bird", "product", "grid", "list"],
  trail: ["paper", "audit"],
  path: ["file", "career", "learning", "critical", "upgrade", "growth"],
  circle: ["full", "inner", "vicious", "half"],
  hill: ["over", "uphill", "downhill"],
});
// Lower-case words that are never part of a street name ("sold 5 in the first place").
const notNameWords = new Set([
  "in",
  "on",
  "at",
  "to",
  "of",
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "by",
  "with",
  "from",
  "into",
  "onto",
  "per",
  "via",
  "our",
  "my",
  "your",
  "his",
  "her",
  "their",
  "its",
  "this",
  "that",
  "these",
  "those",
  "more",
  "less",
  "each",
  "every",
  "first",
  "second",
  "third",
  "last",
  "next",
  "new",
  "old",
  "same",
  "other",
  "all",
  "some",
  "any",
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "lane",
  "way",
  "dirt",
  "toll",
  "side",
  "back",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "can",
  "could",
  "should",
  "may",
  "might",
  "must",
  "not",
  "than",
  "then",
  "so",
  "as",
  "if",
  "up",
  "down",
  "out",
  "over",
  "under",
  "off",
  "about",
  "after",
  "before",
  "between",
  "through",
  "during",
  "without",
  "within",
  "along",
  "across",
  "behind",
  "near",
  "around",
  "top",
  "best",
  "great",
  "good",
  "big",
  "small",
  "little",
  "long",
  "short",
  "high",
  "low",
  "full",
  "half",
  "free",
  "open",
  "easy",
  "fast",
  "slow",
  "days",
  "hours",
  "weeks",
  "months",
  "years",
  "times",
  "items",
  "units",
  "pieces",
  "pcs",
  "orders",
  "products",
  "sales",
  "customers",
  "people",
  "lanes",
  "ways",
  "x",
]);
// After a number ("10 rue de Rivoli"). Not "via" ("sent 2 via Email") or "bd" ("2 bd
// Apartment"): Italian streets come name first, and "bd" is a bedroom as often as a boulevard.
const romanceTypes = new Set([
  "rue",
  "avenue",
  "av",
  "boulevard",
  "chemin",
  "allée",
  "allee",
  "impasse",
  "quai",
  "place",
  "cours",
  "calle",
  "carrer",
  "rua",
  "avenida",
  "travessa",
  "viale",
  "piazza",
  "corso",
  "strada",
  "rambla",
  "paseo",
  "camino",
]);
const nameFirstTypes = new Set([
  "calle",
  "avenida",
  "carrer",
  "rua",
  "travessa",
  "via",
  "viale",
  "piazza",
  "corso",
  "largo",
  "paseo",
  "camino",
  "rambla",
  "rue",
  "strada",
  "vicolo",
  "plaza",
  "praça",
  "praca",
]);
const particles = new Set([
  "de",
  "du",
  "des",
  "la",
  "le",
  "les",
  "del",
  "della",
  "delle",
  "dei",
  "degli",
  "di",
  "da",
  "do",
  "dos",
  "das",
  "dels",
  "d'",
  "l'",
]);
const houseNumber = /^[0-9]{1,5}[A-Za-z]?(?:[-/][0-9]{1,5}[A-Za-z]?)?$/u;
const shortNumber = /^(?:n[.ºo°]{0,2})?[0-9]{1,4}[A-Za-z]?$/iu;
const nameWord = /^(?:[\p{L}][\p{L}'’.-]{0,40}|[0-9]{1,3}(?:st|nd|rd|th))$/u;
const unitWords = new Set([
  "days",
  "day",
  "hours",
  "hour",
  "hrs",
  "weeks",
  "week",
  "months",
  "month",
  "years",
  "year",
  "mins",
  "min",
  "minutes",
  "minute",
  "seconds",
  "items",
  "item",
  "units",
  "unit",
  "pcs",
  "pieces",
  "piece",
  "times",
  "orders",
  "order",
  "products",
  "product",
  "nights",
  "night",
  "people",
  "customers",
  "%",
]);
const titleCase = (w: string) => /^\p{Lu}/u.test(w);
const allCaps = (w: string) => /\p{L}/u.test(w) && w === w.toUpperCase() && w.length > 1;
const bare = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, "");

interface Token {
  readonly raw: string;
  readonly word: string;
  readonly lower: string;
  /** Only spaces or tabs part it from the next token (no comma, stop or line break). */
  readonly runsOn: boolean;
}
const tokenPattern = /[^\s,;()\[\]{}"“”«»|]+/gu;
const runsOnAfter = /^[ \t]+[^\s,;()\[\]{}"“”«»|]/u;
function tokens(masked: string): readonly Token[] {
  const out: Token[] = [];
  for (const m of masked.matchAll(tokenPattern)) {
    const word = bare(m[0]);
    if (word === "") continue;
    const end = m.index + m[0].length;
    const runsOn = !/[.!?:]$/u.test(m[0]) && runsOnAfter.test(masked.slice(end, end + 64));
    out.push({ raw: m[0], word, lower: word.toLowerCase(), runsOn });
  }
  return out;
}
function nameWordOk(w: Token): boolean {
  if (!nameWord.test(w.word)) return false;
  return titleCase(w.word) || !notNameWords.has(w.lower);
}
// "#1001" is an order number and "$12" an amount, never a house number.
const notHouseNumber = (t: Token) => !houseNumber.test(t.word) || /^[#$€£¥₹]/u.test(t.raw);
function englishAddress(t: readonly Token[], i: number): boolean {
  if (notHouseNumber(t[i]!)) return false;
  const before = t[i - 1]?.lower;
  if (before !== undefined && (idWordBefore.test(before) || before === "#")) return false;
  for (let k = 1; k <= 4 && i + k + 1 < t.length; k += 1) {
    const names = t.slice(i + 1, i + k + 1);
    const street = t[i + k + 1]!;
    const word = street.lower.replace(/\.$/u, "");
    const risky = titleCaseStreetWords.has(word);
    if (!risky && !anyCaseStreetWords.has(word)) continue;
    if (!names.every(nameWordOk)) continue;
    const shouting = allCaps(street.word);
    if (names.some((n) => allCaps(n.word)) && !shouting) continue;
    if (risky) {
      if (
        !titleCase(street.word) ||
        !names.every((n) => titleCase(n.word) || /^[0-9]/u.test(n.word))
      )
        continue;
      if ((ordinaryBefore[word] ?? []).includes(names[names.length - 1]!.lower)) continue;
      // "3 Coffee Place mats", "4 Rose Gardens prints": a product name runs on into a noun.
      const next = t[i + k + 2];
      if (street.runsOn && next !== undefined && /^\p{Ll}/u.test(next.word)) continue;
    }
    if (unitWords.has(names[0]!.lower)) continue;
    return true;
  }
  return false;
}
function romanceAddress(t: readonly Token[], i: number): boolean {
  if (notHouseNumber(t[i]!)) return false;
  let j = i + 1;
  if (t[j] && /^(?:bis|ter)$/iu.test(t[j]!.word)) j += 1;
  if (!t[j] || !romanceTypes.has(t[j]!.lower.replace(/\.$/u, ""))) return false;
  j += 1;
  for (let p = 0; p < 2 && t[j] && particles.has(t[j]!.lower); p += 1) j += 1;
  const name = t[j]?.word.replace(/^[ldLD]['’]/u, "");
  return name !== undefined && /^\p{Lu}\p{Ll}/u.test(name);
}
function nameFirstAddress(t: readonly Token[], i: number): boolean {
  const type = t[i]!;
  if (!titleCase(type.word) || !nameFirstTypes.has(type.lower.replace(/\.$/u, ""))) return false;
  let j = i + 1;
  for (let p = 0; p < 2 && t[j] && particles.has(t[j]!.lower); p += 1) j += 1;
  let names = 0;
  while (names < 3 && t[j] && /^\p{Lu}\p{Ll}[\p{L}'’.-]*$/u.test(t[j]!.word)) {
    names += 1;
    j += 1;
  }
  if (names === 0 || !t[j]) return false;
  if (
    /^n[.ºo°]{0,2}$/iu.test(t[j]!.word) &&
    t[j + 1] &&
    /^[0-9]{1,4}[a-z]?$/iu.test(t[j + 1]!.word)
  )
    j += 1;
  if (!shortNumber.test(t[j]!.word)) return false;
  const after = t[j + 1]?.lower;
  return after === undefined || !unitWords.has(after);
}
const compoundStreet =
  /(?<![\p{L}])\p{Lu}[\p{Ll}ß]{1,30}(?:straße|strasse|str\.|gasse|weg|allee|platz|ufer|chaussee|damm|straat|laan|gracht|plein|steeg|kade|singel|vej|gade|gatan|gata|vägen|veien)[ \t]?[0-9]{1,4}[a-z]?(?![\p{L}\p{N}])/u;
const unitAndStreet =
  /\b(?:house|h|plot|flat|apartment|apt|villa|bungalow|unit|suite|shop|office)[ \t]*(?:no\.?|number|#)?[ \t]*[a-z]?-?[0-9]{1,5}[a-z]?[ \t]*,[ \t]*(?:street|st|lane|road|rd|block|sector|phase|gali|mohalla|colony|avenue|ave|floor)\b/iu;
const numberedStreet =
  /\b(?:street|st|lane|gali|road|rd)[ \t]*(?:no\.?|number|#)[ \t]*[0-9]{1,4}\b/iu;
const poBox =
  /\b(?:g?p\.?[ \t]?o\.?|post[ \t]+office)[ \t]*box[ \t]*(?:no\.?|#)?[ \t]*[0-9]{1,7}\b/iu;
const ukAreas =
  "AB|AL|BA|BB|BD|BH|BL|BN|BR|BS|BT|CA|CB|CF|CH|CM|CO|CR|CT|CV|CW|DA|DD|DE|DG|DH|DL|DN|DT|DY|EC|EH|EN|EX|FK|FY|GL|GU|GY|HA|HD|HG|HP|HR|HS|HU|HX|IG|IM|IP|IV|JE|KA|KT|KW|KY|LA|LD|LE|LL|LN|LS|LU|ME|MK|ML|NE|NG|NN|NP|NR|NW|OL|OX|PA|PE|PH|PL|PO|PR|RG|RH|RM|SA|SE|SG|SK|SL|SM|SN|SO|SP|SR|SS|ST|SW|SY|TA|TD|TF|TN|TQ|TR|TS|TW|UB|WA|WC|WD|WF|WN|WR|WS|WV|YO|ZE|B|E|G|L|M|N|S|W";
const ukPostcode = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${ukAreas})[0-9][A-Z0-9]? ?[0-9][ABD-HJLNP-UW-Z]{2}(?![\\p{L}\\p{N}])`,
  "u",
);
const canadianPostcode =
  /(?<![\p{L}\p{N}])[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z][ -]?[0-9][ABCEGHJ-NPRSTV-Z][0-9](?![\p{L}\p{N}])/u;
const usStateZip =
  /,[ \t]*(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|PR|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)[ \t]+[0-9]{5}(?:-[0-9]{4})?(?![\p{N}])/u;
const keywordPostcode =
  /\b(?:postal[ \t]*code|post[ \t]*code|postcode|zip[ \t]*code|zip|pin[ \t]*code|pincode)\b[ \t]*[:#-]?[ \t]*(?=[A-Z]{0,4}[0-9])[A-Z0-9]{2,6}(?:[ -]?[A-Z0-9]{2,5})?\b/iu;

function scanAddresses(masked: string, found: Findings): void {
  if (
    poBox.test(masked) ||
    unitAndStreet.test(masked) ||
    numberedStreet.test(masked) ||
    compoundStreet.test(masked) ||
    ukPostcode.test(masked) ||
    canadianPostcode.test(masked) ||
    usStateZip.test(masked) ||
    keywordPostcode.test(masked)
  ) {
    found.kinds.add("street_address");
    return;
  }
  const t = tokens(masked);
  for (let i = 0; i < t.length; i += 1)
    if (englishAddress(t, i) || romanceAddress(t, i) || nameFirstAddress(t, i)) {
      found.kinds.add("street_address");
      return;
    }
}

// ---------------------------------------------------------------------------------------------
// Every kind needs a digit, an at sign or a written "at" in the scan copy (after the escapes
// that can hide one are decoded); a text without any is clean.
const mayHold = /[0-9@]|\bat\b/iu;
function inspect(texts: readonly string[]): Findings {
  if (!Array.isArray(texts) || texts.length > customerScreenLimits.texts)
    throw Error("CUSTOMER_SCREEN_INPUT");
  let total = 0;
  const found: Findings = { kinds: new Set(), candidates: new Set() };
  for (const text of texts) {
    if (typeof text !== "string") throw Error("CUSTOMER_SCREEN_INPUT");
    if (text.length > customerScreenLimits.textChars) throw Error("CUSTOMER_SCREEN_TEXT_TOO_LONG");
    total += text.length;
    if (total > customerScreenLimits.totalChars) throw Error("CUSTOMER_SCREEN_TEXT_TOO_LONG");
    const scan = scanCopy(text);
    if (!mayHold.test(scan)) continue;
    scanEmails(scan, found);
    scanCustomerIds(scan, found);
    const masked = maskedCopy(scan, found);
    scanPhones(masked, found);
    scanAddresses(masked, found);
  }
  // More looser forms than the list may be asked about: refused as email addresses.
  if (found.candidates.size > customerScreenLimits.listCandidates) found.kinds.add("email");
  return found;
}
const verdictOf = (kinds: ReadonlySet<CustomerDataKind>): CustomerScreenVerdict =>
  kinds.size === 0
    ? Object.freeze({ ok: true as const })
    : Object.freeze({
        ok: false as const,
        code: "customer_data" as const,
        kinds: Object.freeze(customerDataKinds.filter((k) => kinds.has(k))),
      });

/**
 * The pattern screen over one text or several (a structured value's strings), with no keyed
 * list: emails, phones, street addresses and customer ids. Synchronous, for the checks that run
 * inside a synchronous decision function while the list is empty (until P09.T05). A caller with
 * the list binding uses screenCustomerTextsListed.
 */
export function screenCustomerText(text: string): CustomerScreenVerdict {
  return verdictOf(inspect([text]).kinds);
}
export function screenCustomerTexts(texts: readonly string[]): CustomerScreenVerdict {
  return verdictOf(inspect(texts).kinds);
}

/**
 * The full screen: the patterns, then the looser email forms against the keyed list. The list
 * is asked only when the patterns found nothing and a looser form exists; its "unavailable" (or
 * a throw, or any answer but a boolean) fails closed as screen_unavailable, so the caller
 * stores nothing and may retry.
 */
export async function screenCustomerTextsListed(
  texts: readonly string[],
  list: CustomerEmailDigestList,
): Promise<ListedCustomerScreenVerdict> {
  const found = inspect(texts);
  if (found.kinds.size > 0 || found.candidates.size === 0) return verdictOf(found.kinds);
  let listed: unknown;
  try {
    listed = await list.anyListed(Object.freeze([...found.candidates].sort()));
  } catch {
    listed = "unavailable";
  }
  if (typeof listed !== "boolean")
    return Object.freeze({ ok: false as const, code: "screen_unavailable" as const });
  return verdictOf(listed ? new Set<CustomerDataKind>(["listed_email"]) : new Set());
}

/**
 * Every string inside a closed JSON value (a tool input, a structured model output), keys
 * included, in key order, for screenCustomerTexts. Throws CUSTOMER_SCREEN_INPUT on a value that
 * is not plain JSON, is deeper than customerScreenLimits.depth or holds more strings than
 * customerScreenLimits.texts.
 */
export function stringsOf(value: unknown): readonly string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (out.length >= customerScreenLimits.texts) throw Error("CUSTOMER_SCREEN_INPUT");
    out.push(s);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > customerScreenLimits.depth) throw Error("CUSTOMER_SCREEN_INPUT");
    if (typeof v === "string") add(v);
    else if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
    else if (v !== null && typeof v === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw Error("CUSTOMER_SCREEN_INPUT");
      for (const key of Object.keys(v).sort()) {
        add(key);
        walk((v as Record<string, unknown>)[key], depth + 1);
      }
    } else if (
      v !== null &&
      typeof v !== "boolean" &&
      !(typeof v === "number" && Number.isFinite(v))
    )
      throw Error("CUSTOMER_SCREEN_INPUT");
  };
  walk(value, 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Where the screen runs.

/** ADR-0040 item 2's post command: a match is `not_started: customer_data`. */
export type PostScreenResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly delivery: "not_started";
      readonly code: "customer_data";
      readonly refusal: CustomerScreenRefusal;
      readonly safeMessage: typeof customerDataSafeMessage;
    }
  | { readonly ok: false; readonly code: "screen_unavailable" };
/**
 * The post command's first check, before the message, the inbox row or any run sees the text
 * (ADR-0040 item 2; H11b calls it inside the command's transaction, before any insert). The
 * command stores nothing on a refusal and answers with `refusal` and `safeMessage`; on
 * screen_unavailable it stores nothing and answers retryable. `texts` is the post's text and
 * any other person-typed text it carries.
 */
export async function screenPost(
  texts: string | readonly string[],
  list: CustomerEmailDigestList = noListedCustomerEmails,
): Promise<PostScreenResult> {
  const verdict = await screenCustomerTextsListed(
    typeof texts === "string" ? [texts] : texts,
    list,
  );
  if (verdict.ok || verdict.code === "screen_unavailable") return verdict;
  return Object.freeze({
    ok: false as const,
    delivery: "not_started" as const,
    code: "customer_data" as const,
    refusal: customerScreenRefusal(verdict.kinds),
    safeMessage: customerDataSafeMessage,
  });
}

/** CustomerScreenRefusal@1 for a verdict's kinds (sorted, unique, at least one). */
export function customerScreenRefusal(kinds: readonly CustomerDataKind[]): CustomerScreenRefusal {
  const set = new Set(kinds);
  const sorted = customerDataKinds.filter((k) => set.has(k));
  if (sorted.length === 0 || sorted.length !== kinds.length) throw Error("CUSTOMER_SCREEN_KINDS");
  return Object.freeze({
    schemaVersion: 1 as const,
    code: "customer_data" as const,
    kinds: Object.freeze(sorted) as CustomerScreenRefusal["kinds"],
  });
}

/**
 * Every text a model writes that Morrow stores (ADR-0041 items 13 and 31), screened before its
 * commit. Each writer calls screenModelWritten (or, inside a synchronous decision while the list
 * is empty, screenModelWrittenSync) in the same step, before the insert. `wiredIn` names the
 * decision that screens it today; null marks a kind whose writer has not landed, and the PR
 * that first writes it wires it there and records it here (tests/customer-screen.test.mjs
 * checks every wired decision refuses a planted address).
 */
export const modelWrittenTexts = Object.freeze({
  /** Conversation summaries (H12c). */
  conversation_summary: null,
  /** The fallback checkpoint (H7d). */
  context_checkpoint: null,
  /** A provider compaction block (H7e): flagged, it is dropped and the fallback reset runs. */
  compaction_summary: null,
  /** run.plan's plan (H7b). */
  run_plan: null,
  /** run.plan's notes (H7b). */
  plan_note: null,
  /** plan.draft's card (ADR-0034). */
  plan_card: "decidePlanDraft",
  /** run.plan's `understood` (H11a). */
  understood: null,
  /** A ledger item's title (H7d). */
  ledger_title: null,
  /** Teammate result items (H5, H10). */
  result_item: null,
  /** Teammate findings (H10). */
  finding: null,
  /** A teammate's result text (H10). */
  teammate_result: null,
  /** An agent's message: message.post, milestones, check-ins (H11b). */
  message: null,
  /** notebook.write (PR 20). */
  notebook_entry: "decideNotebookWrite",
  /** knowledge.propose (PR 20). */
  knowledge_proposal: "decideKnowledgePropose",
  /** memory.suggest (H12b). */
  memory_suggestion: null,
} as const satisfies Record<string, string | null>);
export type ModelWrittenTextKind = keyof typeof modelWrittenTexts;
export const modelWrittenTextKinds = Object.freeze(
  Object.keys(modelWrittenTexts) as ModelWrittenTextKind[],
);
/** What code does with a flagged text of each kind: refuse it, or reset on code facts. */
export const modelWrittenFlagAction: Readonly<
  Record<ModelWrittenTextKind, "refuse" | "fallback_reset">
> = Object.freeze(
  Object.fromEntries(
    modelWrittenTextKinds.map((k) => [k, k === "compaction_summary" ? "fallback_reset" : "refuse"]),
  ) as Record<ModelWrittenTextKind, "refuse" | "fallback_reset">,
);
export type ModelWrittenScreenResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "customer_data";
      readonly refusal: CustomerScreenRefusal;
      readonly action: "refuse" | "fallback_reset";
    }
  | { readonly ok: false; readonly code: "screen_unavailable" };
const isModelWrittenKind = (kind: unknown): kind is ModelWrittenTextKind =>
  typeof kind === "string" && Object.hasOwn(modelWrittenTexts, kind);
const flagged = (kind: ModelWrittenTextKind, kinds: readonly CustomerDataKind[]) =>
  Object.freeze({
    ok: false as const,
    code: "customer_data" as const,
    refusal: customerScreenRefusal(kinds),
    action: modelWrittenFlagAction[kind],
  });

/** A model-written text (or structured value) before commit, with the keyed list. */
export async function screenModelWritten(
  kind: ModelWrittenTextKind,
  value: unknown,
  list: CustomerEmailDigestList = noListedCustomerEmails,
): Promise<ModelWrittenScreenResult> {
  if (!isModelWrittenKind(kind)) throw Error("CUSTOMER_SCREEN_KIND");
  const verdict = await screenCustomerTextsListed(stringsOf(value), list);
  if (verdict.ok || verdict.code === "screen_unavailable") return verdict;
  return flagged(kind, verdict.kinds);
}
/**
 * The same without the keyed list, for the synchronous tool decisions on main today. It is
 * complete only while the list is empty (until P09.T05): the PR that binds the list moves each
 * caller to screenModelWritten.
 */
export function screenModelWrittenSync(
  kind: ModelWrittenTextKind,
  value: unknown,
): Exclude<ModelWrittenScreenResult, { readonly code: "screen_unavailable" }> {
  if (!isModelWrittenKind(kind)) throw Error("CUSTOMER_SCREEN_KIND");
  const verdict = screenCustomerTexts(stringsOf(value));
  if (verdict.ok) return verdict;
  return flagged(kind, verdict.kinds);
}
