// Review R2 of v1 build order PR 6 (docs/briefs/v1-renew-test-credits.md): ADR-0035 item 4
// needs the owner's yes in chat for every raise of the owner's test credits, and a raise is
// a new BillingTerms revision whose operator_test_entitlement entry carries more credits
// than the beta plan's 300 (R10: the terms stay the only source of credit units). A merged
// pull request alone must not be enough, so an operator entry with any credits other than
// 300 is accepted, by npm run verify:billing and by staging:seed-platform, only when its
// revision in docs/decisions/billing-terms.json names a committed owner record
// (`ownerRecord`, a docs/evidence/live path of the form <date>-test-credits-raise[-slug])
// that names that revision and those credits and quotes the owner's words, which name the
// amount. Each labelled line appears exactly once, read the way the standing approval's
// record is read (a plain line or a Markdown list item, the label optionally in bold):
//   - Terms revision: `staging.2`
//   - Credits per period: `1000`
//   - Owner's words: "Yes, raise my test credits to 1,000 a period."
// The record gates the revision; it never supplies an amount. The renewal and the grant
// still read their credits from the terms only.
export const operatorBaseCreditUnits = "300";
export const raiseRecordPath =
  /^docs\/evidence\/live\/\d{4}-\d{2}-\d{2}-test-credits-raise(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?[.]md$/;
const creditText = /^[1-9][0-9]{0,17}$/;

/**
 * The revision's raise: its operator entry's credits when they are not the base 300, or
 * null. `revision` is a published revision ({terms, offers, digest[, ownerRecord]}).
 */
export function operatorRaise(revision) {
  const entries = revision?.terms?.entries;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries)
    if (
      entry?.kind === "operator_test_entitlement" &&
      entry.creditUnits !== operatorBaseCreditUnits
    )
      return String(entry.creditUnits);
  return null;
}

const raiseLabel =
  /^(?:[-*] +)?(?:\*\*(Terms revision|Credits per period|Owner['’]s words):\*\*|(Terms revision|Credits per period|Owner['’]s words):)(.*)$/;
const raiseValue = /^ +(?:`([^`\s]+)`|([^`\s]+)) *$/;
const ownerWords = /^ +(?:"([^"]{2,600})"|“([^”]{2,600})”) *$/;

/**
 * Why `text` does not record the owner's yes for this raise, or null when it does: one
 * "Terms revision" line naming `<environment>.<termsRevision>`, one "Credits per period"
 * line naming `creditUnits`, and one "Owner's words" line quoting the owner, whose words
 * name the amount (thousands separators allowed).
 */
export function raiseRecordProblem(text, { environment, termsRevision, creditUnits }) {
  if (typeof text !== "string") return "missing";
  if (
    !/^(development|staging)$/.test(environment ?? "") ||
    !Number.isSafeInteger(termsRevision) ||
    termsRevision < 1 ||
    !creditText.test(creditUnits ?? "")
  )
    return "invalid";
  const named = { revision: [], credits: [], words: [] };
  for (const line of text.split(/\r?\n/)) {
    const label = raiseLabel.exec(line.trim());
    if (!label) continue;
    const name = label[1] ?? label[2];
    if (name === "Terms revision") {
      const value = raiseValue.exec(label[3]);
      named.revision.push(value ? (value[1] ?? value[2]) : null);
    } else if (name === "Credits per period") {
      const value = raiseValue.exec(label[3]);
      named.credits.push(value ? (value[1] ?? value[2]) : null);
    } else {
      const value = ownerWords.exec(label[3]);
      named.words.push(value ? (value[1] ?? value[2]) : null);
    }
  }
  if (named.revision.length !== 1 || named.revision[0] !== `${environment}.${termsRevision}`)
    return "revision";
  if (named.credits.length !== 1 || named.credits[0] !== creditUnits) return "credits";
  if (named.words.length !== 1 || named.words[0] === null) return "words";
  // The owner's words name the amount itself: 1000, 1,000 or 1 000 for 1000.
  const words = named.words[0].replace(/(\d)[,   ](?=\d{3}(?!\d))/g, "$1");
  if (!new RegExp(`(?:^|[^0-9])${creditUnits}(?:[^0-9]|$)`).test(words)) return "words";
  return null;
}
