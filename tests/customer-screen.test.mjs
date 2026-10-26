// H9a: the customer identifier screen (ADR-0041 item 31, ADR-0040 item 2;
// docs/briefs/h9a-customer-identifier-screen.md). In Node, with no database: what it finds
// (emails, phones, street addresses, customer ids, the keyed list's looser email forms) in
// every obfuscation it decodes; what it lets through (order numbers and ids, product ids,
// money, dates, codes, ordinary sentences) and what it cannot see (a customer's name); its
// content-free verdict and CustomerScreenRefusal@1; the keyed list port failing closed; its
// bounds and linear time; the post command's and the model-written texts' entry points and
// the decisions wired to it today; lab:shopify-privacy's planted texts and markers; the copy,
// exactly as the records give it. lab:shopify-privacy (phase I) drives the wired decisions
// against PostgreSQL 17.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import {
  customerDataKinds,
  customerDataSafeMessage,
  customerDetailsStandingLine,
  customerEmailDigestInput,
  customerScreenLimits,
  customerScreenRefusal,
  modelWrittenFlagAction,
  modelWrittenTextKinds,
  modelWrittenTexts,
  noListedCustomerEmails,
  screenCustomerText,
  screenCustomerTexts,
  screenCustomerTextsListed,
  screenModelWritten,
  screenModelWrittenSync,
  screenPost,
  stringsOf,
} from "../packages/policy/src/customer-screen.ts";
import { phaseITexts, plantedCustomer } from "../scripts/fixtures/privacy-lab-customer.mjs";
import * as knowledge from "../packages/policy/src/knowledge/index.ts";
import * as projects from "../packages/policy/src/projects/index.ts";
import { copy } from "../packages/workspace-ui/src/copy.ts";

const kindsOf = (text) => {
  const v = screenCustomerText(text);
  return v.ok ? [] : [...v.kinds];
};
const found = (kind, texts) => {
  for (const text of texts)
    assert.ok(kindsOf(text).includes(kind), `${kind}: ${JSON.stringify(text)}`);
};

test("emails: plain, obfuscated, spaced and written out", () => {
  found("email", [
    "jane.doe@example.com",
    "Email: JANE@EXAMPLE.CO.UK please",
    "<jane+promo@shop.example>",
    "mailto:jane@example.org",
    // Full-width and compatibility forms, zero-width and bidi characters, soft hyphens.
    "jane＠example．com",
    "jane​@​example.com",
    "ja­ne@exa⁠mple.com",
    "jane‮@example.com",
    // HTML references and percent escapes, also escaped twice or escaping a full-width at sign.
    "jane&#64;example.com",
    "jane&#x40;example.com",
    "jane&commat;example&period;com",
    "jane%40example.com",
    "jane&amp;#64;example.com",
    "jane&#xFF20;example.com",
    "&#106;ane&#64;example.com",
    // Bracketed at and dot.
    "jane (at) example (dot) com",
    "jane [at] example [dot] com",
    "jane{@}example.com",
    // Spaced or written out, with an address-like local part or a personal mail provider.
    "jane.doe at example dot com",
    "jane_doe at example.com",
    "jane99 @ example.com",
    "jane @ gmail.com",
    "jane at gmail dot com",
    "jane at hotmail.co.uk",
    // A mail provider without its top-level domain.
    "jane@gmail",
    "jane.doe at yahoo",
    // Other scripts.
    "ایمیل: jane@example.com",
    "почта: иван@пример.рф",
  ]);
});

test("phones: international, national, grouped, after a phone word, and in links", () => {
  found("phone", [
    "Call me on +92 300 1234567",
    "+44 20 7946 0958",
    "0044 20 7946 0958",
    "0300-1234567",
    "03001234567",
    "(212) 555-0187",
    "212.555.0187",
    "2125550187",
    "1 212 555 0187",
    "whatsapp 03001234567",
    "phone: 555 0187 22",
    "my cell is 5550187",
    "tel:+15550100",
    "wa.me/923001234567",
    "https://api.whatsapp.com/send?phone=923001234567",
    // Arabic-Indic and Extended Arabic-Indic digits, and full-width ones.
    "٠٣٠٠١٢٣٤٥٦٧",
    "Mobile ۰۳۰۰۱۲۳۴۵۶۷",
    "＋４４ ２０ ７９４６ ０９５８",
    // A dash of another kind.
    "0300‑1234567",
    // Right after a key, a list separator or a mark a model copies tool output with (H9A-R2):
    // key=value, CSV and slash or dot glued forms, and "#" or "-" after a phone word.
    "customer_phone=+923001234567",
    "phone=+14155552671",
    "tel=03001234567",
    "phone_number: 03001234567",
    "customer_phone=5550187",
    "Jane,03001234567,Lahore",
    "name,phone\nJane,+14155552671",
    "Ph#03001234567",
    "Tel#03001234567",
    "Phone-03001234567",
    "ph.03001234567",
    "Jane/03001234567",
    "Number.03001234567",
    // In a link's path or query (H9A-R3).
    "https://example.com/contact?phone=03001234567",
    "https://example.com/call/+44+20+7946+0958",
  ]);
});

test("street addresses: shapes in several languages, PO boxes, units and postcodes", () => {
  found("street_address", [
    "221B Baker Street",
    "742 Evergreen Terrace",
    "12 B4ker Street",
    "Customers post returns to 12 Quill3fa9b2c1 Street.",
    "1600 Pennsylvania Ave NW",
    "Deliver to 12 Main St.",
    "5 High St, Oxford",
    "10 rue de Rivoli",
    "Calle Mayor 5",
    "Via Roma 12",
    "Hauptstraße 12",
    "Kerkstraat 5",
    "House 12, Street 5",
    "Flat 4B, Block C",
    "Street No. 7",
    "PO Box 1234",
    "P.O. Box 77",
    "London SW1A 1AA",
    "EC1A 1BB",
    "Toronto M5V 3L9",
    "Springfield, IL 62704",
    "zip 90210",
    "postcode: 54000",
    "pin code 110001",
    // A label glued to the house number, or the number glued to the street name (H9A-R3).
    "Address:12 Baker Street",
    "address=12 Baker Street",
    "ship_to=221B Baker Street",
    "12-Baker Street",
    "zip=90210",
    // In a map link: its path and query are read, decoded (H9A-R3).
    "Delivery pin: https://maps.google.com/?q=221B+Baker+Street,+London+NW1+6XE",
    "https://www.google.com/maps/place/221B+Baker+St,+London+NW1+6XE",
    "https://www.google.com/maps/search/?api=1&query=12%20Baker%20Street",
    "www.google.com/maps?q=12+Main+Street+Springfield",
    "https://maps.example.com/?q=12%2BBaker%2BStreet",
  ]);
});

test("customer ids: GIDs in every encoding, admin links, record ids and numeric ids", () => {
  const gid = "gid://shopify/Customer/7234567890123";
  found("customer_gid", [
    gid,
    "shopify/Customer/7234567890123",
    "gid://shopify/CustomerAddress/123",
    "gid://shopify/MailingAddress/9",
    "gid://shopify/CustomerPaymentMethod/42",
    "gid://shopify/CustomerSegmentMember/42",
    "gid://shopify/CompanyContact/42",
    "gid%3A%2F%2Fshopify%2FCustomer%2F7234567890123",
    btoa(gid),
    btoa(gid).replace(/=+$/, ""),
    "https://admin.shopify.com/store/my-shop/customers/7234567890123",
    "https://my-shop.myshopify.com/admin/customers/7234567890123",
    "/admin/api/2026-10/customers/7234567890123.json",
    "customer:7234567890123",
    "customer 7234567890123",
    "Customer ID: 7234567890123",
    '{"customer_id": 7234567890123}',
    "customerId=7234567890123",
  ]);
});

test("not customer data: orders, products, money, dates, codes and ordinary sentences", () => {
  for (const text of [
    // Order numbers and order GIDs are not customer data (CLAUDE.md; ADR-0041 item 31).
    "Order #1042 was refunded on 2026-10-20.",
    "gid://shopify/Order/5123456789012",
    "order:5123456789012",
    "https://admin.shopify.com/store/my-shop/orders/5123456789012",
    "gid://shopify/Product/8123456789012 and gid://shopify/ProductVariant/4123456789012",
    btoa("gid://shopify/Product/8123456789012"),
    "Raise prices on 12 products (ids product:1 to product:12).",
    // Money, counts and percentages.
    "Sales grew 14.5% to $12,400.50 this week; AOV $54.20.",
    "Order total: PKR 12,500 for 3 items",
    "Revenue 1234567890",
    "We have 1,204 customers",
    "+5% conversion",
    // Codes, dates, times and addresses of machines.
    "SKU 1234567890",
    "Model 1234567890",
    "UPC 0 12345 67890 5",
    "Tracking number 9400 1000 0000 0000 0000 00",
    "Batch 2026-11 of 1500 units",
    "Valid from 01.12.2026 until 31.12.2026",
    "Our new hours are 9:00-17:00, Monday to Friday",
    "IP 192.168.100.200",
    "Unix time 1730000000",
    "Discount code SAVE20 ends 31/12/2026",
    "customer 2026 survey",
    // Product names and sentences with street words, "at" and at signs.
    "In stock: 2 Hard Drive kits, 3 Flash Drive packs",
    "New arrivals: 3 Coffee Place mats",
    "Buy 4 Rose Gardens prints",
    "Ranked 1 Best Way to start",
    "12 Days of Christmas Way",
    "We met at 9:30 at the shop",
    "find us at shop dot com",
    "available @ amazon.com",
    "Sold 5 @ shop.com",
    "say hi @ me",
    "@Morrow can you help with the tote?",
    "logo@2x.png",
    "Visit https://shop.example.com/products/tote?variant=4123456789012",
    "Read pages 1012-1024",
    "Coordinates 24.8607, 67.0011",
    // Morrow's own record ids (gen_random_uuid, crypto.randomUUID), also digit-led (H9A-R4).
    "31415926-5358-4abc-9def-0123456789ab",
    "Task 27182818-2845-4abc-9def-0123456789ab is done; see project 16180339-8874-4ABC-9DEF-0123456789AB.",
    // Ids, numbers and marks glued to the separators a phone may now follow (H9A-R2, R3).
    "Ticket #2125550187",
    "SKU-2125550187",
    "order_id=2125550187",
    "variant_id=4123456789012",
    "Totals 1,204,567,890 and 3.14159265358979",
    "Ratio 1:2, step 3:4",
    "https://admin.shopify.com/store/my-shop/orders/5123456789012?tab=timeline",
    "https://cdn.shopify.com/s/files/1/0612/3456/7890/files/tote.png?v=1712345678",
    "https://shop.example.com/blogs/news/12-main-street-sale",
    "https://shop.example.com/products/tote?variant=4123456789012&utm_source=x",
    "3-pack Rose Gardens prints",
  ])
    assert.deepEqual(screenCustomerText(text), { ok: true }, JSON.stringify(text));
  // A phone beside a record id is still a phone.
  assert.deepEqual(kindsOf("Task 31415926-5358-4abc-9def-0123456789ab: call 0300-1234567"), [
    "phone",
  ]);
});

test("what it cannot see: a customer's name typed as free text (ADR-0041 item 31)", () => {
  // The gap the standing line and message redaction narrow, and the owner decides.
  for (const text of ["Jane Smith asked for a refund", "Reply to Amina Khan about her parcel"])
    assert.deepEqual(screenCustomerText(text), { ok: true });
});

test("the verdict is content-free, frozen and sorted; the refusal is CustomerScreenRefusal@1", () => {
  const text = "Customer 7234567890123: jane.doe@example.com, +44 20 7946 0958, 221B Baker Street";
  const verdict = screenCustomerText(text);
  assert.deepEqual(verdict, {
    ok: false,
    code: "customer_data",
    kinds: ["email", "phone", "street_address", "customer_gid"],
  });
  assert.ok(Object.isFrozen(verdict) && Object.isFrozen(verdict.kinds));
  const serialised = JSON.stringify(verdict);
  for (const part of ["7234567890123", "jane", "7946", "Baker"])
    assert.equal(serialised.includes(part), false, part);
  const refusal = customerScreenRefusal(verdict.kinds);
  assert.deepEqual(refusal, { schemaVersion: 1, code: "customer_data", kinds: verdict.kinds });
  assert.ok(validateCurrentDefinition("CustomerScreenRefusal", refusal));
  for (const kind of customerDataKinds) {
    assert.ok(validateCurrentDefinition("CustomerDataKind", kind));
    assert.ok(validateCurrentDefinition("CustomerScreenRefusal", customerScreenRefusal([kind])));
  }
  // The contract's enum is the screen's list, in its order.
  const schema = JSON.parse(readFileSync("docs/contracts/schemas/v1.1/core.schema.json", "utf8"));
  assert.deepEqual(schema.$defs.CustomerDataKind.enum, [...customerDataKinds]);
  assert.equal(validateCurrentDefinition("CustomerScreenRefusal", { ...refusal, text }), false);
  assert.equal(
    validateCurrentDefinition("CustomerScreenRefusal", { ...refusal, kinds: [] }),
    false,
  );
  assert.throws(() => customerScreenRefusal([]), /CUSTOMER_SCREEN_KINDS/);
  assert.throws(() => customerScreenRefusal(["email", "email"]), /CUSTOMER_SCREEN_KINDS/);
  assert.throws(() => customerScreenRefusal(["name"]), /CUSTOMER_SCREEN_KINDS/);
  // Several texts: one verdict over all of them.
  assert.deepEqual(screenCustomerTexts(["fine", "call 0300-1234567", "fine too"]), {
    ok: false,
    code: "customer_data",
    kinds: ["phone"],
  });
});

test("the keyed list: asked only for looser forms, with digest inputs; it fails closed", async () => {
  const asked = [];
  const list = (answer) => ({
    async anyListed(inputs) {
      asked.push([...inputs]);
      assert.ok(Object.isFrozen(inputs));
      return typeof answer === "function" ? answer(inputs) : answer;
    },
  });
  const listed = list((inputs) => inputs.includes("morrow.customer-email.v1|jane@acme.com"));
  assert.deepEqual(await screenCustomerTextsListed(["write to jane at acme dot com"], listed), {
    ok: false,
    code: "customer_data",
    kinds: ["listed_email"],
  });
  assert.deepEqual(asked.pop(), ["morrow.customer-email.v1|jane@acme.com"]);
  assert.deepEqual(await screenCustomerTextsListed(["Jane @ Acme.com"], listed), {
    ok: false,
    code: "customer_data",
    kinds: ["listed_email"],
  });
  assert.deepEqual(asked.pop(), ["morrow.customer-email.v1|jane@acme.com"]);
  // An unlisted looser form passes.
  assert.deepEqual(await screenCustomerTextsListed(["we sell at amazon.com"], listed), {
    ok: true,
  });
  assert.deepEqual(asked.pop(), ["morrow.customer-email.v1|sell@amazon.com"]);
  // Never asked for clean text, or when a pattern already refused it.
  assert.deepEqual(await screenCustomerTextsListed(["nothing here"], listed), { ok: true });
  assert.deepEqual(
    await screenCustomerTextsListed(["jane at acme dot com, 0300-1234567"], listed),
    {
      ok: false,
      code: "customer_data",
      kinds: ["phone"],
    },
  );
  assert.equal(asked.length, 0);
  // Unavailable, a throw or a non-boolean answer: screen_unavailable, nothing stored.
  for (const answer of [
    "unavailable",
    () => {
      throw Error("broker down");
    },
    () => Promise.reject(Error("broker down")),
    "yes",
    undefined,
    1,
  ])
    assert.deepEqual(await screenCustomerTextsListed(["jane at acme dot com"], list(answer)), {
      ok: false,
      code: "screen_unavailable",
    });
  // More looser forms than the list may be asked about are refused as addresses, unasked.
  asked.length = 0;
  const many = Array.from(
    { length: customerScreenLimits.listCandidates + 1 },
    (_, i) => `name${"abcdefghijklmnopqrstuvwxyz"[i % 26]}x at shop${i} dot com`,
  );
  assert.deepEqual(await screenCustomerTextsListed(many, listed), {
    ok: false,
    code: "customer_data",
    kinds: ["email"],
  });
  assert.equal(asked.length, 0);
  // Before P09.T05 the list is empty.
  assert.deepEqual(
    await screenCustomerTextsListed(["jane at acme dot com"], noListedCustomerEmails),
    {
      ok: true,
    },
  );
});

test("the digest input is normalised, domain-separated and closed", () => {
  assert.equal(
    customerEmailDigestInput("Jane.Smith+promo@GMail.com"),
    "morrow.customer-email.v1|jane.smith@gmail.com",
  );
  assert.equal(
    customerEmailDigestInput(" ＪＡＮＥ@example.com. "),
    "morrow.customer-email.v1|jane@example.com",
  );
  for (const bad of ["", "jane", "@example.com", "jane@", "jane@example", "a b@example.com", 42])
    assert.equal(customerEmailDigestInput(bad), null, String(bad));
  assert.equal(customerEmailDigestInput("a".repeat(65) + "@example.com"), null);
});

test("bounds: closed inputs, refused sizes, and every structured string screened", () => {
  assert.throws(
    () => screenCustomerText("x".repeat(customerScreenLimits.textChars + 1)),
    /TOO_LONG/,
  );
  assert.throws(
    () => screenCustomerTexts(Array(5).fill("x".repeat(customerScreenLimits.textChars))),
    /TOO_LONG/,
  );
  assert.throws(() => screenCustomerTexts(Array(customerScreenLimits.texts + 1).fill("")), /INPUT/);
  assert.throws(() => screenCustomerTexts(["x", 1]), /CUSTOMER_SCREEN_INPUT/);
  assert.throws(() => screenCustomerTexts("x"), /CUSTOMER_SCREEN_INPUT/);
  // stringsOf: keys and values, in key order; plain JSON only, bounded depth and count.
  assert.deepEqual(stringsOf({ b: ["x", { "jane@x.com": 1 }], a: "y", n: null, t: true, z: 2 }), [
    "a",
    "y",
    "b",
    "x",
    "jane@x.com",
    "n",
    "t",
    "z",
  ]);
  assert.deepEqual(stringsOf("one"), ["one"]);
  assert.deepEqual(stringsOf(Object.assign(Object.create(null), { k: "v" })), ["k", "v"]);
  for (const bad of [new Date(), new Map(), () => 1, Symbol("s"), 1n, NaN, Infinity, [undefined]])
    assert.throws(() => stringsOf(bad), /CUSTOMER_SCREEN_INPUT/, String(typeof bad));
  let deep = "x";
  for (let i = 0; i <= customerScreenLimits.depth; i += 1) deep = [deep];
  assert.throws(() => stringsOf(deep), /CUSTOMER_SCREEN_INPUT/);
  assert.throws(
    () => stringsOf(Array(customerScreenLimits.texts + 1).fill("x")),
    /CUSTOMER_SCREEN_INPUT/,
  );
  // A key holding an address is screened like any value.
  assert.equal(screenModelWrittenSync("result_item", { "jane@example.com": "x" }).ok, false);
});

test("linear time: a mebibyte of adversarial text is screened in bounded time", () => {
  // Every pattern is bounded; a quadratic one would take hours on these at the full bound. Each
  // shape (a head, a filler repeated, a tail; or numbered parts) is timed at a 64th, a 16th, a
  // quarter and all of the bound, so a quadratic pattern fails at the first size it overruns,
  // within minutes, and never hangs the run (H9A-R1). The bound is wide for a loaded machine
  // (each takes a few seconds there).
  const size = customerScreenLimits.textChars;
  const shapes = [
    ...[
      "1 ",
      "1",
      "a@",
      "a at b dot ",
      "12 Main ",
      "Z2lkOi8v",
      "+1 (",
      "@ ",
      "&#64;",
      "%40",
      "customer ",
      "jane.doe @ ",
    ].map((unit) => ["", unit, ""]),
    // Long runs of spaces, tabs and punctuation (H9A-R1): the bracketed "(at)", the loose email
    // forms, a token's trimming, and the address and postcode patterns with a space run inside.
    ["a", " ", "b"],
    ["1 a", " ", "b"],
    ["1 (", " ", "x"],
    ["", "\t", "1"],
    ["1 a", "*", "a"],
    ["1 a", "*.", "a"],
    ["1 zip", " ", "x"],
    ["1 h", " ", "x"],
    ["1 jane", " ", "x @ b"],
    ["1 x at", " ", "y"],
    ["", "%20", "1"],
    // The masked copy's runs: a masked link, GID or date leaves a run of spaces in place.
    ["1 zip ", "www.a ", "x"],
    ["1 h ", "www.a ", "x 5, Street"],
    ["1 po box ", "gid://a ", "x"],
    ["1 Springfield, CA ", "2026-10-27 ", "x"],
    ["1 street ", "www.a ", "x"],
    // Links read for addresses and phones, glued labels and separators (H9A-R2, R3).
    ["", "https://maps.example/?q=12+Main+", ""],
    ["", "whatsapp.com/send?a=", ""],
    ["", "a:1 ", ""],
    ["", "1,", ""],
    ["", "=+1", ""],
    ["", "12-a ", ""],
    ["", "31415926-5358-4abc-9def-0123456789ab ", ""],
    // Distinct links, each decoded and scanned on its own.
    (i) => `https://maps.example/?q=${i}+Main+x&p=${i * 7} `,
  ];
  const textOf = (shape, n) => {
    if (typeof shape === "function") {
      let text = "";
      for (let i = 0; text.length < n; i += 1) text += shape(i);
      return text.slice(0, n);
    }
    const [head, fill, tail] = shape;
    return (head + fill.repeat(Math.ceil(n / fill.length))).slice(0, n - tail.length) + tail;
  };
  for (const shape of shapes)
    for (const n of [size / 64, size / 16, size / 4, size]) {
      const text = textOf(shape, n);
      assert.equal(text.length, n);
      const started = performance.now();
      screenCustomerText(text);
      const ms = performance.now() - started;
      const name = typeof shape === "function" ? shape(0) : JSON.stringify(shape);
      assert.ok(ms < 20_000, `${name} at ${n} took ${Math.round(ms)} ms`);
    }
});

test("the post command's entry point: not_started customer_data with the safe message", async () => {
  assert.deepEqual(await screenPost("Can you raise the tote's price by 10%?"), { ok: true });
  const refused = await screenPost("Refund jane.doe@example.com for order #1042");
  assert.deepEqual(refused, {
    ok: false,
    delivery: "not_started",
    code: "customer_data",
    refusal: { schemaVersion: 1, code: "customer_data", kinds: ["email"] },
    safeMessage: customerDataSafeMessage,
  });
  assert.ok(validateCurrentDefinition("CustomerScreenRefusal", refused.refusal));
  assert.equal(JSON.stringify(refused).includes("jane"), false);
  assert.deepEqual((await screenPost(["fine", "PO Box 1234"])).refusal.kinds, ["street_address"]);
  assert.deepEqual(
    await screenPost("jane at acme dot com", { anyListed: async () => "unavailable" }),
    { ok: false, code: "screen_unavailable" },
  );
});

test("model-written texts: every kind refused before commit, a compaction summary reset", async () => {
  assert.deepEqual([...modelWrittenTextKinds], Object.keys(modelWrittenTexts));
  for (const kind of modelWrittenTextKinds) {
    const action = kind === "compaction_summary" ? "fallback_reset" : "refuse";
    assert.equal(modelWrittenFlagAction[kind], action);
    const flagged = await screenModelWritten(kind, { text: "Call 0300-1234567" });
    assert.deepEqual(flagged, {
      ok: false,
      code: "customer_data",
      refusal: { schemaVersion: 1, code: "customer_data", kinds: ["phone"] },
      action,
    });
    assert.deepEqual(screenModelWrittenSync(kind, "Call 0300-1234567"), flagged);
    assert.deepEqual(await screenModelWritten(kind, ["Order #1042 shipped."]), { ok: true });
  }
  assert.deepEqual(
    await screenModelWritten("message", "jane at acme dot com", {
      anyListed: async () => "unavailable",
    }),
    { ok: false, code: "screen_unavailable" },
  );
  await assert.rejects(screenModelWritten("note", "x"), /CUSTOMER_SCREEN_KIND/);
  assert.throws(() => screenModelWrittenSync("toString", "x"), /CUSTOMER_SCREEN_KIND/);
});

test("every decision the registry names screens the text its model wrote (H9a wiring)", async () => {
  const wired = Object.entries(modelWrittenTexts).filter(([, name]) => name !== null);
  assert.deepEqual(wired.map(([kind]) => kind).sort(), [
    "knowledge_proposal",
    "notebook_entry",
    "plan_card",
  ]);
  const run = {
    context: "routed",
    readTags: [],
    taint: "untrusted_external",
    agentTools: "on",
  };
  const exported = { ...knowledge, ...projects };
  for (const [, name] of wired) assert.equal(typeof exported[name], "function", name);
  assert.deepEqual(
    exported.decideKnowledgePropose(
      { pageId: null, kind: "policy", title: "Returns", text: "jane@example.com", sources: [] },
      run,
    ),
    { ok: false, outcome: "refused", refusal: "customer_data" },
  );
  assert.deepEqual(exported.decideNotebookWrite({ text: "PO Box 1234" }, run), {
    ok: false,
    outcome: "refused",
    refusal: "customer_data",
  });
  // plan.draft: tests/plan-draft.test.mjs drives the card fixtures through decidePlanDraft.
  const source = readFileSync("packages/policy/src/projects/plan-draft.ts", "utf8");
  assert.match(source, /screenModelWrittenSync\("plan_card", mapped\)/);
});

test("lab:shopify-privacy's markers cover every form phase I plants, and the screen refuses each", () => {
  // O1 (no log line) and I4 (no refusal) search the log and the refusals for the markers; a
  // form without its marker would pass them unseen (H9A-R6). Several runs' random values.
  for (let run = 0; run < 8; run += 1) {
    const customer = plantedCustomer();
    const planted = phaseITexts(customer);
    const texts = [
      ...planted.notebook,
      planted.returnsText,
      planted.giftSource,
      planted.repliesText,
      ...planted.posts,
    ];
    assert.equal(texts.length, 9);
    for (const text of texts) {
      assert.ok(
        customer.markers.some((m) => text.includes(m)),
        `no marker for ${JSON.stringify(text)}`,
      );
      assert.equal(screenCustomerText(text).ok, false, text);
    }
    // O1's own guard: each marker is long enough not to match by chance.
    assert.ok(customer.markers.every((m) => typeof m === "string" && m.length > 8));
    // Each planted form is its own marker: the spaced phone and the obfuscated email.
    assert.ok(customer.markers.includes(customer.screenPhone));
    assert.ok(customer.markers.includes(customer.obfuscatedEmail));
  }
  // The lab takes its customer, texts and markers from the fixture.
  const lab = readFileSync("scripts/shopify-privacy-lab.mjs", "utf8");
  assert.match(lab, /\.\.\.labCustomer\.markers/);
  assert.match(lab, /plantedTexts\.posts/);
});

test("the copy, exactly as ADR-0040 and ADR-0041 give it, and the module stays edge-safe", () => {
  assert.equal(
    customerDataSafeMessage,
    "Morrow can't keep customer details yet. Remove them and send again.",
  );
  for (const record of [
    "docs/decisions/adr/ADR-0040-messaging-with-agents.md",
    "docs/decisions/adr/ADR-0041-harness-foundations.md",
  ]) {
    const text = readFileSync(record, "utf8");
    assert.ok(text.includes(`"${customerDataSafeMessage}"`), record);
  }
  assert.ok(
    readFileSync("docs/decisions/adr/ADR-0041-harness-foundations.md", "utf8").includes(
      `"${customerDetailsStandingLine.replace(/\.$/, "")}"`,
    ),
  );
  // The workspace's composers carry the same words.
  assert.equal(copy.customerDetails.standing, customerDetailsStandingLine);
  assert.equal(copy.customerDetails.refused, customerDataSafeMessage);
  // No I/O and nothing Node-only: it runs in the api, runtime and broker Workers.
  const source = readFileSync("packages/policy/src/customer-screen.ts", "utf8");
  assert.doesNotMatch(source, /from "node:|require\(|fetch\(|console\./);
  assert.match(
    JSON.parse(readFileSync("packages/policy/package.json", "utf8")).exports["./customer-screen"],
    /customer-screen\.ts$/,
  );
});
