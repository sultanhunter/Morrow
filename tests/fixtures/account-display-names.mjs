// P05.T01x-AC30 display-name vectors, shared by the unit tests (TypeScript rule) and the
// PostgreSQL laboratory (SQL display_name_valid). W and F are the packet's section 5 sets.
export const whitespaceCodePoints = Object.freeze([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029,
  0x202f, 0x205f, 0x3000,
]);
// One code point from each end of every F range; NUL is TypeScript-only (PostgreSQL text
// cannot hold it).
export const forbiddenCodePoints = Object.freeze([
  0x01, 0x1f, 0x7f, 0x9f, 0x61c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069,
  0xfeff,
]);
const inside = (code) => "a" + String.fromCodePoint(code) + "b";
// Rejected by both layers with invalid_name.
export const invalidNames = Object.freeze([
  "",
  String.fromCodePoint(...whitespaceCodePoints),
  "a".repeat(101),
  "\u{1F600}".repeat(101),
  ...forbiddenCodePoints.map(inside),
]);
// Rejected only by TypeScript (PostgreSQL cannot receive them).
export const typescriptOnlyInvalidNames = Object.freeze(["a\u0000b", "a\ud800b", "a\udc00b"]);
// SQL never trims, so edge whitespace and a non-NFC name are invalid there.
export const sqlOnlyInvalidNames = Object.freeze([" x", "x ", "\u3000x", "Cafe\u0301"]);
// [sent, stored]: TypeScript normalizes to NFC and trims W before SQL sees the name.
export const acceptedNames = Object.freeze([
  ["Cafe\u0301 Noor", "Caf\u00E9 Noor"],
  ["\u0645\u062A\u062C\u0631 \u0646\u0648\u0631", "\u0645\u062A\u062C\u0631 \u0646\u0648\u0631"],
  ["Mi\u200Cnoor", "Mi\u200Cnoor"],
  ["\u3000 Main \u00A0", "Main"],
  ["\u{1F600}".repeat(100), "\u{1F600}".repeat(100)],
]);
