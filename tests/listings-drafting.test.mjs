// M3 PR-2: the Listings specialist's code checks, outside any prompt (build-plan invariant
// 13; mvp-architecture §2 step 8 and §7-§8): the listing HTML sanitiser, the model output
// check (ListingDraft@1, the requested product, the run's fields only, bounds, no-ops,
// reviewer flags), the built-in Coordinator's route record and the catalog.content.publish
// producer (Proposal@2 records packed by bytes). lab:listings-runs drives the same code
// against PostgreSQL 17 through the agent submit definer.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  decodeEntities,
  listingHtmlText,
  sanitizeListingHtml,
} from "../packages/work/src/runs/html.ts";
import {
  checkDraft,
  draftLimits,
  listingFields,
  runFieldsValid,
  snapshotCanonical,
} from "../packages/work/src/runs/drafting.ts";
import {
  coordinatorRoute,
  listingsWorkflowVersion,
} from "../packages/work/src/runs/coordinator.ts";
import { packListingProposals, producerCaps } from "../packages/work/src/runs/producer.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const bytes = (text) => Buffer.byteLength(text, "utf8");

test("the sanitiser keeps only the allowlist, with no attribute, and is idempotent", () => {
  const cases = [
    ["<p>Plain</p>", "<p>Plain</p>"],
    ['<p onclick="steal()" class="x">Hi</p>', "<p>Hi</p>"],
    ["<P>Upper</P>", "<p>Upper</p>"],
    ["<h1>Big</h1><h2>Sub</h2>", "Big<h2>Sub</h2>"],
    ["<ul><li>a<li>b</ul>", "<ul><li>a<li>b</li></li></ul>"],
    ["a<br>b<br/>c</br>", "a<br>b<br>c"],
    ['<a href="https://evil.example">link</a>', "link"],
    ['<img src=x onerror="alert(1)">after', "after"],
    ["<script>alert(1)</script>kept", "kept"],
    ["<style>p{}</style><iframe src=x>inner</iframe>ok", "ok"],
    ["<svg><script>x</script></svg>ok", "ok"],
    ["<!-- note -->text<!doctype html><?php x ?>", "text"],
    ["<strong>bold <em>both</strong> tail", "<strong>bold <em>both</em></strong> tail"],
    ["</p>stray</em>", "stray"],
    ["1 < 2 and 3 > 2", "1 &lt; 2 and 3 &gt; 2"],
    ["&lt;script&gt;alert(1)&lt;/script&gt;", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["Fish &amp; chips &#169; &#x2122; &bogus;", "Fish &amp; chips © ™ &amp;bogus;"],
    ['<p title="a>b">quoted</p>', "<p>quoted</p>"],
    ["<scr<script>ipt>alert(1)</script>", "ipt&gt;alert(1)"],
    ["<p>open", "<p>open</p>"],
    ["<textarea><p>hidden</p></textarea>shown", "shown"],
  ];
  for (const [input, expected] of cases) {
    const once = sanitizeListingHtml(input);
    assert.equal(once, expected, input);
    // Serialising the output again changes nothing (the readback comparison relies on it).
    assert.equal(sanitizeListingHtml(once), once, input);
    // No tag but the allowlist, and no attribute, survives.
    for (const m of once.matchAll(/<\/?([a-z0-9]+)([^>]*)>/g)) {
      assert.ok(["p", "br", "strong", "em", "ul", "ol", "li", "h2", "h3", "h4"].includes(m[1]));
      assert.equal(m[2], "");
    }
  }
  assert.throws(() => sanitizeListingHtml(null), /LISTING_HTML_INVALID/);
  assert.equal(decodeEntities("&#0;&#xD800;&#x110000;"), "���");
  assert.equal(listingHtmlText("<p>A</p><p>B &amp; C</p>").replace(/\s+/g, " ").trim(), "A B & C");
});

const snapshot = Object.freeze({
  productId: "product:42",
  title: "Old title",
  descriptionHtml: "<p>Old description. Call 555-010-9999.</p>",
  seo: { title: null, description: null },
  tags: ["Summer", "cotton"],
});
const draft = (over = {}) => ({
  productId: "product:42",
  title: null,
  descriptionHtml: null,
  seo: null,
  tags: null,
  ...over,
});

test("run fields: 1-5 distinct listing fields, sorted, with the SEO pair", () => {
  assert.deepEqual(
    [...listingFields],
    ["descriptionHtml", "seo.description", "seo.title", "tags", "title"],
  );
  assert.ok(runFieldsValid(["title"]));
  assert.ok(runFieldsValid(["descriptionHtml", "seo.description", "seo.title", "tags", "title"]));
  for (const bad of [
    [],
    ["title", "descriptionHtml"],
    ["title", "title"],
    ["seo.title"],
    ["seo.description", "title"],
    ["price"],
    "title",
    null,
  ])
    assert.equal(runFieldsValid(bad), false, JSON.stringify(bad));
});

test("the draft check: ListingDraft@1 for the requested product, the run's fields only", () => {
  const ok = checkDraft(draft({ title: "  New title  " }), "product:42", snapshot, ["title"]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.set, { title: "New title" });
  assert.deepEqual(ok.fields, ["title"]);
  assert.equal(ok.setCanonical, '{"title":"New title"}');
  assert.ok(validateCurrentDefinition("CatalogContentSet", JSON.parse(ok.setCanonical)));
  // Another product id is product_mismatch, whatever else the draft holds.
  assert.deepEqual(
    checkDraft(draft({ productId: "product:43", title: "X" }), "product:42", snapshot, ["title"]),
    { ok: false, code: "product_mismatch" },
  );
  // A field outside the run's is dropped: only the title is proposed.
  const only = checkDraft(
    draft({ title: "New", descriptionHtml: "<p>Other</p>", tags: ["x"] }),
    "product:42",
    snapshot,
    ["title"],
  );
  assert.deepEqual(only.fields, ["title"]);
  assert.deepEqual(Object.keys(only.set), ["title"]);
  // Unchanged under the canonical comparison: nothing to propose is a validation failure.
  for (const [output, fields] of [
    [draft({ title: " Old title " }), ["title"]],
    [
      draft({ descriptionHtml: "<p onclick=x>Old description. Call 555-010-9999.</p>" }),
      ["descriptionHtml"],
    ],
    [draft({ tags: ["cotton", "SUMMER", " summer "] }), ["tags"]],
    [draft({ title: "Ignored" }), ["tags"]],
  ])
    assert.deepEqual(checkDraft(output, "product:42", snapshot, fields), {
      ok: false,
      code: "validation",
    });
  // Anything outside ListingDraft_v1 / ListingDraft@1 fails closed.
  for (const bad of [
    null,
    "text",
    [],
    { productId: "product:42", title: "x", price: "1.00" },
    draft({ title: "" }),
    draft({ title: "t".repeat(256) }),
    draft({ descriptionHtml: "d".repeat(10_001) }),
    draft({ seo: { title: "only title" } }),
    draft({ tags: ["dup", "dup"] }),
    draft({ tags: Array.from({ length: 51 }, (_, i) => "t" + i) }),
    { productId: "42", title: "x" },
  ])
    assert.equal(checkDraft(bad, "product:42", snapshot, ["tags", "title"]).ok, false);
  // The run's fields must be a valid run field list (a caller bug, not model output).
  assert.throws(
    () => checkDraft(draft({ title: "x" }), "product:42", snapshot, ["seo.title"]),
    /LISTING_FIELDS_INVALID/,
  );
});

test("the draft check: HTML sanitised, SEO as a pair, tags trimmed and folded, bounds", () => {
  const html = checkDraft(
    draft({
      descriptionHtml:
        '<p class="x">New <strong>soft</strong> cotton.<script>steal()</script><a href="https://x.example">More</a></p>',
    }),
    "product:42",
    snapshot,
    ["descriptionHtml"],
  );
  assert.equal(html.ok, true);
  assert.equal(html.set.descriptionHtml, "<p>New <strong>soft</strong> cotton.More</p>");
  const seo = checkDraft(
    draft({ seo: { title: " SEO title ", description: "A description." } }),
    "product:42",
    snapshot,
    ["seo.description", "seo.title"],
  );
  assert.deepEqual(seo.fields, ["seo.description", "seo.title"]);
  assert.deepEqual(seo.set, { seo: { title: "SEO title", description: "A description." } });
  const tags = checkDraft(
    draft({ tags: [" Summer ", "linen", "LINEN ", "Linen"] }),
    "product:42",
    snapshot,
    ["tags"],
  );
  // Trimmed, de-duplicated case-insensitively; "cotton" removed, "linen" added.
  assert.deepEqual(tags.set, { tags: ["Summer", "linen"] });
  assert.deepEqual([tags.flags.tagsAdded, tags.flags.tagsRemoved, tags.flags.newUrls], [1, 1, 0]);
  // The description bound applies after sanitising.
  const long = "<p>" + "x".repeat(draftLimits.descriptionBytes) + "</p>";
  assert.equal(
    checkDraft(draft({ descriptionHtml: long.slice(0, 10_000) }), "product:42", snapshot, [
      "descriptionHtml",
    ]).ok,
    false,
  );
  assert.equal(
    checkDraft(
      draft({ seo: { title: "t".repeat(71), description: "d" } }),
      "product:42",
      snapshot,
      ["seo.description", "seo.title"],
    ).ok,
    false,
  );
});

test("reviewer flags count the links, emails and phones the draft adds (counts, no content)", () => {
  const r = checkDraft(
    draft({
      title: "Shirt from www.example-shop.com",
      descriptionHtml:
        "<p>Mail sales@example.com or call +1 (555) 010-1234. Old: 555-010-9999. See https://a.example/x.</p>",
    }),
    "product:42",
    snapshot,
    ["descriptionHtml", "title"],
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.flags, {
    newUrls: 2,
    newEmails: 1,
    newPhones: 1,
    tagsAdded: 0,
    tagsRemoved: 0,
  });
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.flags) && Object.isFrozen(r.set));
  // The flags carry numbers only.
  assert.ok(Object.values(r.flags).every((v) => Number.isSafeInteger(v) && v >= 0 && v <= 999));
});

test("the snapshot's canonical text: ListingSnapshot only, RFC 8785 order", () => {
  const text = snapshotCanonical(snapshot);
  assert.equal(
    text,
    '{"descriptionHtml":"<p>Old description. Call 555-010-9999.</p>","productId":"product:42","seo":{"description":null,"title":null},"tags":["Summer","cotton"],"title":"Old title"}',
  );
  assert.throws(() => snapshotCanonical({ ...snapshot, extra: 1 }), /LISTING_SNAPSHOT_INVALID/);
  assert.throws(() => snapshotCanonical({ ...snapshot, productId: "gid://shopify/Product/1" }));
});

const routeInput = (over = {}) => ({
  organizationId: "org_o",
  workspaceId: "ws_w",
  runId: randomUUID(),
  taskId: "task_root",
  childTaskId: randomUUID(),
  installationId: "installation_listings",
  storeId: "store_a",
  connectionId: "connection_a",
  products: ["product:1", "product:2"],
  fields: ["descriptionHtml", "title"],
  ...over,
});

test("the built-in Coordinator writes CoordinatorRoute@1 (ids only) as RFC 8785 text", () => {
  assert.equal(listingsWorkflowVersion, "listings-run@1");
  const input = routeInput();
  const { route, canonical } = coordinatorRoute(input);
  assert.ok(validateCurrentDefinition("CoordinatorRoute", route));
  assert.equal(route.dispatcher, "builtin_coordinator");
  assert.equal(route.specialist, "morrow.listings");
  assert.equal(canonical, JSON.stringify(Object.fromEntries(Object.entries(route).sort())));
  assert.equal(coordinatorRoute(input).canonical, canonical);
  for (const bad of [
    { fields: ["seo.title"] },
    { products: [] },
    { products: ["product:1", "product:1"] },
    { products: Array.from({ length: 26 }, (_, i) => "product:" + (i + 1)) },
    { storeId: "" },
  ])
    assert.throws(() => coordinatorRoute(routeInput(bad)), /COORDINATOR_ROUTE_INVALID/);
});

const run = Object.freeze({
  organizationId: "org_o",
  workspaceId: "ws_w",
  storeId: "store_a",
  connectionId: "connection_a",
  taskId: "task_root",
  installationId: "installation_listings",
  agentPrincipalId: "agent_listings",
  requesterPrincipalId: "merchant",
  requesterMembershipId: "membership_merchant",
});
const pending = (index, description) => {
  const set = { descriptionHtml: description, title: "Title " + index };
  return {
    draftId: randomUUID(),
    productIndex: index,
    productId: "product:" + (index + 1),
    snapshotDigest: sha("snapshot " + index),
    fields: ["descriptionHtml", "title"],
    setCanonical: JSON.stringify(Object.fromEntries(Object.entries(set).sort())),
  };
};
const createdAt = "2026-10-22T10:00:00.000Z";

test("the producer packs drafts by bytes into Proposal@2 records, in product order", () => {
  // 25 drafts of ~9.6 KB each: three fit one 32 KiB parameter document.
  const drafts = Array.from({ length: 25 }, (_, i) =>
    pending(i, "<p>" + "x".repeat(9_600) + "</p>"),
  );
  const shuffled = [...drafts].reverse();
  const packed = packListingProposals(run, shuffled, null, createdAt, randomUUID);
  assert.equal(packed.length, 9);
  assert.deepEqual(
    packed.flatMap((p) => p.draftIds),
    drafts.map((d) => d.draftId),
  );
  for (const [i, p] of packed.entries()) {
    assert.ok(bytes(p.parametersCanonical) <= producerCaps.parametersBytes);
    assert.equal(p.parametersDigest, sha(p.parametersCanonical));
    assert.equal(p.proposalDigest, sha(p.proposalCanonical));
    assert.ok(validateCurrentDefinition("Proposal", p.proposal));
    assert.ok(
      validateCurrentDefinition("CatalogContentChangeSet", JSON.parse(p.parametersCanonical)),
    );
    const proposal = p.proposal;
    assert.equal(proposal.capabilityId, "catalog.content.publish");
    assert.equal(proposal.maximumCredits, "0");
    assert.equal(proposal.maximumCost, null);
    assert.equal(proposal.contextTaint, "untrusted_external");
    assert.equal(proposal.partialApproval, "allowed");
    assert.deepEqual(
      [
        proposal.proposedBy.kind,
        proposal.proposedBy.principalId,
        proposal.proposedBy.installationId,
      ],
      ["agent", "agent_listings", "installation_listings"],
    );
    assert.deepEqual(
      [
        proposal.requestedBy.kind,
        proposal.requestedBy.principalId,
        proposal.requestedBy.membershipId,
      ],
      ["human", "merchant", "membership_merchant"],
    );
    assert.equal(proposal.parametersDigest, p.parametersDigest);
    assert.equal(proposal.reviewPolicyRef.digest, p.policyDigest);
    // Each target binds its product's snapshot digest as the expected source revision.
    for (const [t, target] of proposal.targets.entries()) {
      const d = drafts.find((x) => x.draftId === p.draftIds[t]);
      assert.equal(target.expectedSourceRevision, d.snapshotDigest);
      assert.equal(target.resource.id, d.productId);
      assert.equal(target.resource.connectionId, "connection_a");
      assert.equal(target.maximumCredits, "0");
    }
    // The first proposal seeds review policy revision 1; the rest bind it.
    assert.equal(p.policyCanonical === null, i > 0);
  }
  assert.equal(sha(packed[0].policyCanonical), packed[0].policyDigest);
  // A current policy is bound, never re-seeded; small drafts share one proposal.
  const current = {
    revision: 1,
    canonical: packed[0].policyCanonical,
    digest: packed[0].policyDigest,
  };
  const small = packListingProposals(
    run,
    drafts.slice(0, 3).map((d, i) => pending(i, "<p>short</p>")),
    current,
    createdAt,
    randomUUID,
  );
  assert.equal(small.length, 1);
  assert.equal(small[0].policyCanonical, null);
  assert.equal(small[0].policyDigest, current.digest);
  // A forged current policy, a bad time or a field outside the listing fields fails closed.
  for (const call of [
    () =>
      packListingProposals(
        run,
        drafts.slice(0, 1),
        { ...current, digest: "0".repeat(64) },
        createdAt,
        randomUUID,
      ),
    () =>
      packListingProposals(
        { ...run, workspaceId: "ws_other" },
        drafts.slice(0, 1),
        current,
        createdAt,
        randomUUID,
      ),
    () => packListingProposals(run, drafts.slice(0, 1), null, "2026-10-22T10:00:00Z", randomUUID),
    () =>
      packListingProposals(run, [{ ...drafts[0], fields: ["price"] }], null, createdAt, randomUUID),
  ])
    assert.throws(call, /LISTINGS_PRODUCER_INVALID/);
});
