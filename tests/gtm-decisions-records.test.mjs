// The owner's go-to-market decisions of 2026-10-27 (OD-2026-10-27-1): the answer "recommended" to
// six decisions the lead proposed after a research report. These checks keep the records that
// carry them consistent: WhatsApp first and Plivo voice second in ADR-0042, with the WhatsApp
// provider still open; COD Confirmation the first India add-on, decided on or after 2027-01-31;
// a private US$99 design-partner plan in ADR-0026 at the default plan's price per credit, with
// US$149 still provisional; storefront audits outside Morrow (ADR-0035); and the Business
// Analyst's weekly COD and RTO report as a launch deliverable in `mvp.md`, from Level 1 data only.
// Pure: reads repository files only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");
const odPath = "docs/graph/decisions/OD-2026-10-27-1.md";
const adr42Path = "docs/decisions/adr/ADR-0042-connected-services-and-customer-contact.md";
const adr26Path = "docs/decisions/adr/ADR-0026-billing-and-price.md";
const adr35Path = "docs/decisions/adr/ADR-0035-build-v1-live.md";
const planPath = "docs/plan/connected-services-implementation.md";
const mvpPath = "docs/plan/mvp.md";
const readmePath = "docs/decisions/adr/README.md";
const briefPath = "docs/briefs/analyst-weekly-rto-report.md";
const sheetPath = "docs/graph/questions/Q-adr-0042-owner-questions.md";
const referencesPath = "docs/references/connected-services-and-contact.md";

/** Prose with its line breaks folded, so a phrase wrapped across lines still matches. */
const flat = (text) => text.replace(/\s+/g, " ");

/** The text from a marker to the next marker, or to the end when `end` is null. */
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing ${JSON.stringify(start)}`);
  if (end === null) return text.slice(from);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return text.slice(from, to);
};

/** The cells of the table row whose first cell is `id`. */
const row = (text, id) => {
  const lines = text.split("\n").filter((l) => l.startsWith(`| ${id} | `));
  assert.equal(lines.length, 1, `exactly one row ${id}`);
  return lines[0].replace(/^\| /, "").replace(/ \|$/, "").split(" | ");
};

/** A record's 2026-10-27 Amendments note, from its heading to the end of the file. */
const amendment = (text, heading) => flat(between(text, `### 2026-10-27: ${heading}`, null));

// The six decisions exactly as the lead put them to the owner, which "recommended" accepts.
const proposal = [
  "1. **India launch agents:** lead with Listings, Inventory and the weekly RTO report. Offer COD confirmation as a waitlist for the first add-on. *Recommended.*",
  '2. **COD timing:** move it from "later" to "first India add-on after launch", and decide on 31 January based on demand from your meetings. *Recommended.*',
  "3. **COD channel:** WhatsApp first, on a rupee-billed account, instead of the Plivo voice calls ADR-0042 picked first. It's cheaper and safer under TRAI's new rules, and Plivo's own terms ask for explicit consent anyway. *Recommended.* It changes a provider choice, so I'd record it formally, and a lawyer still needs to answer the India questions before any outside merchant.",
  "4. **India price:** US$149 is about ₹14,400 on a Shopify bill. Add any Shopify plan and the total crosses ₹15,000, so the merchant has to approve the bill by bank OTP every month. *Recommended:* ask US$149 by default, and let yourself offer a private US$99 plan (about ₹9,600) to named design partners when price or the OTP blocks a commitment.",
  "5. **Spend:** about ₹1.5–4.1 lakh over 90 days. It starts with one month of StoreLeads Pro (US$250, about ₹23,800) to count and list the brands doing 1,000–10,000 orders a month. That purchase is yours to make; I won't buy anything.",
  "6. **Audits:** make the storefront audits outside Morrow until launch, so no other store's data enters the live environment. *Recommended.*",
];

test("OD-2026-10-27-1 records the owner's exact answer, the six decisions and what was not decided", () => {
  const od = read(odPath);
  const front = between(od, "---\n", "\n---\n");
  for (const line of [
    "id: OD-2026-10-27-1",
    "type: decision",
    "status: recorded",
    "date: 2026-10-27",
    "by: owner",
    "channel: chat",
  ])
    assert.ok(front.split("\n").includes(line), line);
  assert.ok(front.includes("amends: [OD-2026-10-26-9, OD-2026-10-23-7]"));
  assert.ok(front.includes("refines: [OD-2026-10-23-10]"));

  // The answer, in full and nothing else, as the first line of the body.
  const body = od.slice(od.indexOf("\n---\n", 4) + 5).trimStart();
  assert.equal(body.split("\n")[0], "> recommended");
  assert.equal(od.match(/^> /gm).length, 1, "one quoted line: the answer");

  const prose = flat(od);
  for (const decision of proposal) assert.ok(prose.includes(decision), decision.slice(0, 40));
  assert.ok(prose.includes("https://claude.ai/artifact/SwZovVyTmdKNF5zHP1YYcY"));

  const notDecided = flat(between(od, "## Not decided here", null));
  for (const item of [
    "AI product photography",
    "the pitch wording",
    "outreach tactics",
    "a pincode or region view of RTO",
    "the 50/50 split",
    "engaging counsel",
  ])
    assert.ok(notDecided.includes(item), item);
});

test("ADR-0042: WhatsApp first on an INR-billed account, Plivo voice second, the provider still open", () => {
  const adr = read(adr42Path);
  const note = amendment(adr, "WhatsApp first, Plivo voice second;");
  assert.ok(note.includes("the text above is kept as approved"));
  assert.ok(note.includes("WhatsApp comes first, on an INR-billed WhatsApp Business account."));
  assert.ok(note.includes("Plivo voice (India region) becomes the second channel"));
  assert.ok(
    note.includes(
      "Which WhatsApp provider the shop uses, Meta's Cloud API directly or a named BSP, is still open.",
    ),
  );
  assert.ok(note.includes("the WhatsApp entry is built only after the owner names the provider"));
  // The facts cited, with their sources.
  for (const fact of [
    "from 2027-01-01 Meta stops delivering messages from their non-INR accounts",
    "a USD account cannot be switched",
    "utility messages sent inside an open customer-service window",
    '"Cold calling is prohibited in India"',
    "its start dates come from one vendor only and are unconfirmed ([I20])",
  ])
    assert.ok(note.includes(fact), fact);
  // Orders without an opt-in, and the CLAUDE.md lines that wait for the owner's words.
  assert.ok(note.includes("Orders without a recorded WhatsApp opt-in get no WhatsApp step"));
  assert.ok(note.includes("none names Plivo, a calling provider, voice or a voice-first order"));
  // Counsel's four new questions.
  const counsel = between(note, "**Counsel's questions**", "**Item 27");
  for (const question of [
    "whether Plivo's consent terms",
    "the Third Amendment's real dates, the A2P declaration, and its termination charge",
    "the 1601 series",
    "the draft CCPA guidelines on unsolicited communications",
  ])
    assert.ok(counsel.includes(question), question);
  // Decision 2: the timing, with item 27 otherwise unchanged.
  assert.ok(note.includes("It is the first India add-on after launch: on or after 2027-01-31"));
  assert.ok(note.includes("COD Confirmation stays an installable agent that is not built"));

  // The answered question carries a dated pointer; the answer's own text is kept.
  const q4 = adr.split("\n").find((l) => l.startsWith("4. The first service: Plivo calls"));
  assert.ok(q4.includes("*Answered as recommended: Plivo first; WhatsApp after your answer"));
  assert.ok(q4.includes("(Note of 2026-10-27: the owner amended this answer in OD-2026-10-27-1"));
  assert.ok(
    flat(read(sheetPath)).includes("the owner amended question 4's answer in OD-2026-10-27-1"),
  );

  // Every source code the note cites is in the references' section 5.
  const references = between(read(referencesPath), "## 5. ", "## Claims in ADR-0042");
  for (const code of new Set(note.match(/\[[IO]\d{2}\]/g)))
    assert.ok(references.includes(`**${code}**`), `${code} in the references`);
});

test("the plan puts the WhatsApp rows ahead of Plivo's, with no row renumbered", () => {
  const plan = read(planPath);
  const ids = plan
    .split("\n")
    .filter((l) => /^\| CS\d/.test(l))
    .map((l) => l.split(" | ")[0].slice(2));
  for (const id of ["CS10c", "CS10d", "CS10a", "CS10b", "CS13", "CS15a", "CS16b"])
    assert.equal(ids.filter((x) => x === id).length, 1, id);
  assert.ok(ids.indexOf("CS10c") < ids.indexOf("CS10d"));
  assert.ok(ids.indexOf("CS10d") < ids.indexOf("CS10a"));
  assert.ok(!ids.includes("CS10"), "no unlettered CS10 row");

  const [, , , cs10cAfter, , cs10cDoes] = row(plan, "CS10c");
  assert.ok(cs10cAfter.includes("naming the WhatsApp provider"));
  assert.ok(cs10cDoes.startsWith("The first channel (OD-2026-10-27-1)."));
  const [, cs10dTitle, , cs10dAfter] = row(plan, "CS10d");
  assert.equal(cs10dTitle, "WhatsApp entry record and live qualification on an INR-billed account");
  assert.ok(cs10dAfter.startsWith("CS10c;"));
  const [, , , cs10aAfter] = row(plan, "CS10a");
  assert.ok(cs10aAfter.includes("the second channel, after CS10c (OD-2026-10-27-1)"));
  const [, , , cs15aAfter] = row(plan, "CS15a");
  assert.ok(cs15aAfter.startsWith("CS10c"));
  const cs16bDoes = row(plan, "CS16b")[5];
  assert.ok(
    cs16bDoes.indexOf("the WhatsApp entry's `service-entry:<entry>`") <
      cs16bDoes.indexOf("`service-entry:plivo-in`"),
  );

  const actions = flat(between(plan, "## Owner actions in this plan", "## Not in these PRs"));
  assert.ok(actions.includes("On or after 2027-01-31: decide, from the demand measured"));
  assert.ok(actions.includes("with the four that OD-2026-10-27-1 adds"));
});

test("ADR-0026: a private US$99 plan for named design partners, its grant pro rata, US$149 still provisional", () => {
  const note = amendment(read(adr26Path), "item 1 gains a private US$99 plan");
  assert.ok(note.includes("US$99 a month, offered only to design partners the owner names"));
  assert.ok(note.includes("**US$149 stays the default ask, and stays provisional.**"));
  assert.ok(note.includes("This decision does not confirm US$149."));
  assert.ok(note.includes("the default plan's grant times 99/149, rounded down to a whole credit"));
  assert.ok(note.includes("This follows from item 5"));
  assert.ok(note.includes("The owner can change it"));
  assert.ok(note.includes("must use at most 50% of the private plan's grant as well"));
  assert.ok(note.includes("the listing, and any website price, show the public plan only"));
  assert.ok(note.includes("[M30]") && note.includes("[M23]") && note.includes("[M27]"));
  assert.ok(note.includes("The owner creates the private plan in the Partner Dashboard"));
  // Nowhere is US$149 recorded as confirmed.
  assert.doesNotMatch(flat(read(adr26Path)), /US\$149 (is|was) confirmed/);
});

test("ADR-0035: storefront audits of prospects stay outside Morrow until the public launch", () => {
  const note = amendment(read(adr35Path), "storefront audits of prospects stay outside Morrow");
  assert.ok(
    note.includes(
      "Until the public launch, storefront audits of prospects are made outside Morrow.",
    ),
  );
  assert.ok(
    note.includes(
      "No other store's data, public storefront pages included, enters Morrow's environment",
    ),
  );
  assert.ok(note.includes("Lead lists and audits never enter this repository"));
});

test("mvp.md and its brief: the weekly COD and RTO report at launch, Level 1 only", () => {
  const mvp = read(mvpPath);
  const analyst = row(mvp, "Business Analyst")[1];
  assert.ok(analyst.includes("a weekly COD and RTO report in rupees"));
  assert.ok(analyst.includes("Level 1 order reads only, so with no address and no pincode view"));
  assert.ok(row(mvp, "T12 Launch agents and evals")[1].includes("weekly COD and RTO report"));
  assert.ok(row(mvp, "T13 Shopify billing")[1].includes("a private US$99 plan's price and grant"));
  const notAtLaunch = flat(between(mvp, "## Not at launch", null));
  assert.ok(
    notAtLaunch.includes(
      "COD Confirmation (ADR-0042) is the first India add-on after launch, not a launch agent: on or after 2027-01-31",
    ),
  );

  const brief = read(briefPath);
  for (const section of [
    "## Goal",
    "## Scope",
    "## Interfaces touched",
    "## Security notes",
    "## Test checklist",
  ])
    assert.ok(brief.includes(`\n${section}\n`), section);
  const scope = flat(between(brief, "## Scope", "## Interfaces touched"));
  assert.ok(scope.startsWith("## Scope 1. **First, check on the owner's store**"));
  assert.ok(scope.includes("How a returned or failed delivery shows in Shopify is unverified"));
  assert.ok(scope.includes("No model or tool writes a figure"));
  assert.ok(scope.includes("come with CS8's minimiser mappings"));
  assert.ok(flat(brief).includes("Not in it: a pincode or region view"));
});

test("the README rows name the amendment, and no record turns the undecided items into decisions", () => {
  const readme = read(readmePath);
  for (const id of ["0026", "0035", "0042"]) {
    const line = readme.split("\n").find((l) => l.startsWith(`| [${id}](`));
    assert.ok(line.includes("(OD-2026-10-27-1, 2026-10-27:"), `README row ${id}`);
  }
  // The spend, the lead lists and the report's other recommendations stay out of the records.
  for (const path of [adr42Path, adr26Path, adr35Path, planPath, mvpPath, briefPath]) {
    const text = read(path);
    assert.doesNotMatch(text, /StoreLeads/, path);
    assert.doesNotMatch(text, /50\/50/, path);
  }
  // The CLAUDE.md lines the owner will confirm do not name a provider or put voice first, as
  // OD-2026-10-27-1 and ADR-0042's Amendments say.
  const proposed = [...flat(read(sheetPath)).matchAll(/- Proposed: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(proposed.length, 4, "four proposed lines");
  assert.ok(proposed.some((line) => line.includes("call plan")));
  for (const line of proposed) assert.doesNotMatch(line, /Plivo|voice|WhatsApp/i);
  assert.doesNotMatch(read("CLAUDE.md"), /Plivo/);
});
