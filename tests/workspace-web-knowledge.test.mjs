// PR 20 Shop knowledge on the Sunrise screen (docs/briefs/shop-knowledge.md). The HTTP adapter
// over the knowledge routes is uncomposed in this build (the default-off switch: nothing is
// sent); composed in a test-only build, its requests are exact paths with closed bodies that
// name nothing the server assigns, and its decoders accept only the server's closed replies
// (lab:shop-knowledge feeds them the real ones). The fixture models the rules the screen must
// respect: who writes, who deletes, one brand voice, a stale version and a suggestion bound to
// its digest change nothing. The screen says typed text only, never customer details, and
// offers only what the server allows. No browser and no network.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "../apps/workspace-web/src/http/client.ts";
import { createHttpPort, requests } from "../apps/workspace-web/src/http/api.ts";
import { composed, loginBodyVersion } from "../apps/workspace-web/src/http/composed.ts";
import {
  decodeKnowledgeDeleted,
  decodeKnowledgePage,
  decodeKnowledgePages,
  decodeKnowledgeProposals,
  decodeKnowledgeWritten,
  decodeNotebook,
  decodeSuggestionDecided,
} from "../apps/workspace-web/src/http/knowledge-decoders.ts";
import { createFixtureAdapter } from "../apps/workspace-web/src/fixtures/adapter.ts";
import { fixtureWorkspace } from "../apps/workspace-web/src/fixtures/seed.ts";
import { teamPortMethods } from "../packages/workspace-ui/src/team-model.ts";
import { sunriseCopy } from "../packages/workspace-ui/src/sunrise/copy.ts";
import { ServicesProvider } from "../packages/workspace-ui/src/services.tsx";
import { KnowledgeBody } from "../packages/workspace-ui/src/screens/library.tsx";
import { json, recordingTransport } from "./fixtures/workspace-web.mjs";

// tsx compiles the components' JSX with the classic runtime here: React must be in scope.
globalThis.React = React;
const h = React.createElement;
const ws = fixtureWorkspace.id;
const PAGE = "3f0c9a52-6b1e-4c2d-8e7f-0a1b2c3d4e5f";
const PROPOSAL = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DIGEST = "d".repeat(64);
const command = (body) => ({ key: randomUUID(), body });
const knowledgeMethods = [
  "library.knowledge",
  "library.knowledgePage",
  "library.addKnowledge",
  "library.editKnowledge",
  "library.deleteKnowledge",
  "library.decideSuggestion",
  // An agent's notebook (the agent page's notes), behind the same switch.
  "team.notebook",
];
const k = sunriseCopy.knowledge;

// A test-only build with the shop-knowledge methods composed (the switch on).
function onPort(responder) {
  const recorded = recordingTransport(responder);
  const on = { ...composed };
  for (const method of knowledgeMethods) on[method] = true;
  return {
    calls: recorded.calls,
    port: createHttpPort({
      client: createClient({ transport: recorded.transport, online: () => true }),
      composed: on,
      loginBodyVersion,
      navigationSignal: () => undefined,
    }),
  };
}

// The server's replies, as packages/work/src/knowledge/commands.ts builds them.
const pagesReply = {
  schemaVersion: 1,
  pages: [
    {
      id: PAGE,
      kind: "brand_voice",
      title: "Our voice",
      version: 2,
      excerpt: "Warm, plain and short.",
      updatedAt: "2026-10-24T10:00:00.000Z",
    },
  ],
  pendingProposals: 1,
  may: { write: true, delete: false },
};
const proposal = {
  schemaVersion: 1,
  id: PROPOSAL,
  pageId: PAGE,
  baseVersion: 2,
  kind: "brand_voice",
  title: "Our voice",
  text: "Warm and short. We say thank you.",
  sources: [{ kind: "product", value: "product:4242" }],
  installationId: "installation_k",
  contextTaint: "untrusted_external",
  digest: DIGEST,
  createdAt: "2026-10-24T11:00:00.000Z",
};
const proposalsReply = { schemaVersion: 1, proposals: [proposal] };
const version = (n, sources = [{ kind: "note", value: "Written by the owner" }]) => ({
  schemaVersion: 1,
  pageId: PAGE,
  version: n,
  title: "Our voice",
  text: "Warm, plain and short.",
  sources,
  author: { kind: "person", principalId: "principal_a", installationId: null },
  acceptedByPrincipalId: "principal_a",
  proposalId: null,
  createdAt: "2026-10-24T10:00:00.000Z",
});
const pageReply = {
  schemaVersion: 1,
  page: {
    schemaVersion: 1,
    id: PAGE,
    kind: "brand_voice",
    current: version(2),
    versionCount: 2,
    createdAt: "2026-10-20T10:00:00.000Z",
  },
  versions: [],
};

test("the switch: the Shop knowledge methods are uncomposed in this build and send nothing", async () => {
  for (const method of knowledgeMethods) {
    assert.ok(teamPortMethods.includes(method), method);
    assert.equal(composed[method], false, method);
  }
  const recorded = recordingTransport(() => {
    throw Error("no request expected");
  });
  const port = createHttpPort({
    client: createClient({ transport: recorded.transport, online: () => true }),
    composed,
    loginBodyVersion,
    navigationSignal: () => undefined,
  });
  assert.equal((await port.library.knowledge(ws)).kind, "not_in_build");
  assert.equal(
    (
      await port.library.addKnowledge(
        ws,
        command({ pageKind: "policy", title: "Returns", text: "30 days.", note: "" }),
      )
    ).kind,
    "not_in_build",
  );
  assert.equal(recorded.calls.length, 0);
});

test("requests: exact paths and closed bodies, naming nothing the server assigns", () => {
  const base = `/workspace/${ws}/work/knowledge`;
  assert.deepEqual(requests.knowledgePages(ws), { method: "GET", path: base + "/pages" });
  assert.deepEqual(requests.knowledgeProposals(ws), { method: "GET", path: base + "/proposals" });
  assert.deepEqual(requests.knowledgePage(ws, PAGE), {
    method: "GET",
    path: `${base}/pages/${PAGE}`,
  });
  const body = (request) => JSON.parse(request.body);
  const add = requests.addKnowledge(
    ws,
    command({ pageKind: "policy", title: "Returns", text: "30 days.", note: "" }),
  );
  assert.equal(add.path, base + "/pages");
  assert.deepEqual(body(add), { kind: "policy", title: "Returns", text: "30 days.", sources: [] });
  // The note is the version's only source; a body never names a tag, author, tenant or version.
  const noted = requests.addKnowledge(
    ws,
    command({ pageKind: "supplier", title: "Weave Co.", text: "3 weeks.", note: "Their email" }),
  );
  assert.deepEqual(body(noted).sources, [{ kind: "note", value: "Their email" }]);
  const edit = requests.editKnowledge(
    ws,
    PAGE,
    command({ title: "Our voice", text: "Warm.", note: "", expectedVersion: 2 }),
  );
  assert.equal(edit.path, `${base}/pages/${PAGE}/versions`);
  assert.deepEqual(body(edit), {
    expectedVersion: 2,
    title: "Our voice",
    text: "Warm.",
    sources: [],
  });
  const remove = requests.deleteKnowledge(ws, PAGE, command({ expectedVersion: 2 }));
  assert.equal(remove.path, `${base}/pages/${PAGE}/delete`);
  assert.deepEqual(body(remove), { expectedVersion: 2 });
  for (const decision of ["accept", "reject"]) {
    const r = requests.decideSuggestion(ws, PROPOSAL, command({ decision, digest: DIGEST }));
    assert.equal(r.path, `${base}/proposals/${PROPOSAL}/${decision}`);
    assert.deepEqual(body(r), { digest: DIGEST });
  }
  for (const r of [add, noted, edit, remove])
    for (const key of ["workspaceId", "organizationId", "readTags", "author", "version", "pageId"])
      assert.equal(Object.hasOwn(body(r), key), false, key);
  // Characters as the server and the form count them: 8,000 emoji are one page's text.
  assert.ok(
    requests.addKnowledge(
      ws,
      command({ pageKind: "policy", title: "Emoji", text: "🙂".repeat(8000), note: "" }),
    ),
  );
});

test("requests: refused before sending, never a guess", () => {
  const content = { title: "Returns", text: "30 days.", note: "" };
  for (const bad of [
    { ...content, pageKind: "customer" },
    { ...content, pageKind: "policy", title: "" },
    { ...content, pageKind: "policy", title: "   " },
    { ...content, pageKind: "policy", title: "x".repeat(121) },
    { ...content, pageKind: "policy", text: "x".repeat(8001) },
    { ...content, pageKind: "policy", text: "a\u0000b" },
    { ...content, pageKind: "policy", note: "x".repeat(201) },
    { ...content, pageKind: "policy", note: " " },
  ])
    assert.equal(requests.addKnowledge(ws, command(bad)), null, JSON.stringify(bad));
  assert.equal(requests.addKnowledge("../ws", command({ ...content, pageKind: "policy" })), null);
  assert.equal(
    requests.addKnowledge(ws, { key: "not-a-key", body: { ...content, pageKind: "policy" } }),
    null,
  );
  assert.equal(requests.knowledgePage(ws, "a/b"), null);
  for (const expectedVersion of [0, 1.5, "2"])
    assert.equal(
      requests.editKnowledge(ws, PAGE, command({ ...content, expectedVersion })),
      null,
      String(expectedVersion),
    );
  assert.equal(requests.deleteKnowledge(ws, PAGE, command({ expectedVersion: 0 })), null);
  for (const [decision, digest] of [
    ["approve", DIGEST],
    ["accept", "D".repeat(64)],
    ["accept", "d".repeat(63)],
  ])
    assert.equal(requests.decideSuggestion(ws, PROPOSAL, command({ decision, digest })), null);
});

test("the adapter: pages and suggestions read once each and merged; a reply outside the shape is unconfirmed", async () => {
  const { calls, port } = onPort(({ path }) =>
    path.endsWith("/knowledge/pages") ? json(200, pagesReply) : json(200, proposalsReply),
  );
  const outcome = await port.library.knowledge(ws);
  assert.equal(outcome.kind, "ok");
  assert.deepEqual(
    calls.map((c) => [c.init.method, c.path]),
    [
      ["GET", `/workspace/${ws}/work/knowledge/pages`],
      ["GET", `/workspace/${ws}/work/knowledge/proposals`],
    ],
  );
  assert.deepEqual(outcome.value.may, { write: true, delete: false });
  assert.deepEqual(outcome.value.items, [
    {
      id: PAGE,
      kind: "fact",
      title: "Our voice",
      text: "Warm, plain and short.",
      source: "Updated 2026-10-24",
      pageKind: "brand_voice",
      version: 2,
      digest: null,
      untrusted: false,
    },
    {
      id: PROPOSAL,
      kind: "suggested",
      title: "Our voice",
      text: "Warm and short. We say thank you.",
      source: "Suggested by an agent · 2026-10-24",
      pageKind: "brand_voice",
      version: 2,
      digest: DIGEST,
      untrusted: true,
    },
  ]);
  // A reply naming read tags (they never leave the server) or missing `may` is not read as ok.
  for (const reply of [
    { ...pagesReply, pages: [{ ...pagesReply.pages[0], readTags: [] }] },
    { ...pagesReply, may: undefined },
    { ...pagesReply, pages: [{ ...pagesReply.pages[0], excerpt: "" }] },
  ]) {
    const { port: p } = onPort(() => json(200, reply));
    assert.deepEqual(await p.library.knowledge(ws), { kind: "unavailable", offline: false });
  }
  // The committed switch's 503 is "not available yet", never a guess.
  const { port: held } = onPort(() =>
    json(503, {
      schemaVersion: 1,
      code: "unavailable",
      retryClass: "recheck_before_retry",
      safeMessage: "Shop knowledge is not available yet.",
      correlationId: "c-1",
      operationId: null,
      retryAfterSeconds: null,
      inputRequestIds: [],
    }),
  );
  assert.deepEqual(await held.library.knowledge(ws), { kind: "unavailable", offline: false });
});

test("decoders: each reply only for the record the path names", () => {
  assert.equal(decodeKnowledgePages(pagesReply).facts.length, 1);
  assert.equal(decodeKnowledgePages({ ...pagesReply, extra: 1 }), null);
  assert.equal(decodeKnowledgeProposals(proposalsReply).length, 1);
  for (const bad of [
    { ...proposal, pageId: null },
    { ...proposal, contextTaint: "maybe" },
    { ...proposal, digest: "x" },
    { ...proposal, readTags: [] },
  ])
    assert.equal(decodeKnowledgeProposals({ schemaVersion: 1, proposals: [bad] }), null);
  assert.deepEqual(decodeKnowledgePage(pageReply, PAGE), {
    id: PAGE,
    pageKind: "brand_voice",
    title: "Our voice",
    text: "Warm, plain and short.",
    note: "Written by the owner",
    version: 2,
  });
  assert.equal(decodeKnowledgePage(pageReply, PROPOSAL), null);
  assert.equal(
    decodeKnowledgePage({ ...pageReply, page: { ...pageReply.page, versionCount: 3 } }, PAGE),
    null,
  );
  assert.deepEqual(decodeKnowledgeWritten({ schemaVersion: 1, pageId: PAGE, version: 3 }, PAGE), {
    pageId: PAGE,
    version: 3,
  });
  assert.equal(decodeKnowledgeWritten({ schemaVersion: 1, pageId: PAGE, version: 3 }, "p2"), null);
  assert.equal(
    decodeKnowledgeWritten({ schemaVersion: 1, pageId: PAGE, version: 3, replayed: false }, null),
    null,
  );
  const deleted = {
    schemaVersion: 1,
    pageId: PAGE,
    versionsErased: 2,
    searchEntriesErased: 1,
    proposalsClosed: 1,
  };
  assert.deepEqual(decodeKnowledgeDeleted(deleted, PAGE), { pageId: PAGE });
  assert.equal(decodeKnowledgeDeleted({ ...deleted, searchEntriesErased: 2 }, PAGE), null);
  assert.deepEqual(
    decodeSuggestionDecided(
      { schemaVersion: 1, proposalId: PROPOSAL, pageId: PAGE, version: 3 },
      PROPOSAL,
      "accept",
    ),
    { decision: "accept" },
  );
  assert.deepEqual(
    decodeSuggestionDecided(
      { schemaVersion: 1, proposalId: PROPOSAL, status: "rejected", replayed: true },
      PROPOSAL,
      "reject",
    ),
    { decision: "reject" },
  );
  // An accept reply is not a reject's, and the other way round.
  assert.equal(
    decodeSuggestionDecided(
      { schemaVersion: 1, proposalId: PROPOSAL, status: "rejected" },
      PROPOSAL,
      "accept",
    ),
    null,
  );
});

test("an agent's notebook: uncomposed, one exact read, and only that agent's entries newest first", async () => {
  const INSTALLATION = "installation_k";
  const entry = (sequence, text) => ({
    schemaVersion: 1,
    id: `0000000${sequence}-1111-4111-8111-111111111111`,
    installationId: INSTALLATION,
    sequence,
    text,
    createdAt: "2026-10-24T12:00:00.000Z",
  });
  // The server's reply (commands.ts notebookRead): the entries this person may see, newest first.
  const reply = {
    installationId: INSTALLATION,
    entries: [entry(2, "Product 4242 needs care facts."), entry(1, "Keep titles under 60.")],
  };
  assert.equal(composed["team.notebook"], false);
  const recorded = recordingTransport(() => {
    throw Error("no request expected");
  });
  const off = createHttpPort({
    client: createClient({ transport: recorded.transport, online: () => true }),
    composed,
    loginBodyVersion,
    navigationSignal: () => undefined,
  });
  assert.equal((await off.team.notebook(ws, INSTALLATION)).kind, "not_in_build");
  assert.equal(recorded.calls.length, 0);
  const path = `/workspace/${ws}/work/agents/${INSTALLATION}/notebook`;
  assert.deepEqual(requests.notebook(ws, INSTALLATION), { method: "GET", path });
  assert.equal(requests.notebook(ws, "a/b"), null);
  const { calls, port } = onPort(() => json(200, reply));
  assert.deepEqual(await port.team.notebook(ws, INSTALLATION), {
    kind: "ok",
    value: {
      entries: [
        { id: reply.entries[0].id, text: "Product 4242 needs care facts." },
        { id: reply.entries[1].id, text: "Keep titles under 60." },
      ],
    },
    replayed: false,
  });
  assert.deepEqual(
    calls.map((c) => [c.init.method, c.path]),
    [["GET", path]],
  );
  assert.deepEqual(decodeNotebook({ installationId: INSTALLATION, entries: [] }, INSTALLATION), {
    entries: [],
  });
  // Anything outside the exact shape is not read: another agent's notebook or entry, a read tag
  // (they never leave the server), the oldest first, a repeated entry, empty text, too many.
  for (const bad of [
    { ...reply, installationId: "installation_other" },
    { ...reply, entries: [{ ...reply.entries[0], installationId: "installation_other" }] },
    { ...reply, entries: [{ ...reply.entries[0], readTags: [] }] },
    { ...reply, entries: [...reply.entries].reverse() },
    { ...reply, entries: [reply.entries[0], { ...reply.entries[1], id: reply.entries[0].id }] },
    { ...reply, entries: [{ ...reply.entries[0], text: " " }] },
    { ...reply, entries: [{ ...reply.entries[0], text: "x".repeat(2001) }] },
    { ...reply, entries: [{ ...reply.entries[0], schemaVersion: 2 }] },
    { ...reply, entries: Array.from({ length: 101 }, (_, i) => entry(101 - i, "Note")) },
    { ...reply, schemaVersion: 1 },
  ])
    assert.equal(decodeNotebook(bad, INSTALLATION), null, JSON.stringify(bad).slice(0, 120));
  const { port: odd } = onPort(() => json(200, { ...reply, installationId: "installation_other" }));
  assert.deepEqual(await odd.team.notebook(ws, INSTALLATION), {
    kind: "unavailable",
    offline: false,
  });
  // The fixture: Listings keeps three notes; another agent none; an unknown agent is not found.
  const fixture = createFixtureAdapter("ready");
  const listings = await fixture.team.notebook(ws, "agent-listings");
  assert.equal(listings.kind, "ok");
  assert.equal(listings.value.entries.length, 3);
  assert.equal((await fixture.team.notebook(ws, "agent-absent")).kind, "not_found");
});

test("commands over the adapter: a stale version is a conflict to recheck; a lost reply is uncertain", async () => {
  const { port: stale } = onPort(() =>
    json(409, {
      schemaVersion: 1,
      code: "conflict",
      retryClass: "recheck_before_retry",
      safeMessage: "This changed since you opened it. Open it again.",
      correlationId: "c-2",
      operationId: null,
      retryAfterSeconds: null,
      inputRequestIds: [],
    }),
  );
  assert.deepEqual(
    await stale.library.editKnowledge(
      ws,
      PAGE,
      command({ title: "Our voice", text: "Warm.", note: "", expectedVersion: 1 }),
    ),
    {
      kind: "conflict",
      recheck: true,
      message: "This changed since you opened it. Open it again.",
    },
  );
  const { port: lost } = onPort(() => {
    throw TypeError("network");
  });
  assert.equal(
    (await lost.library.deleteKnowledge(ws, PAGE, command({ expectedVersion: 2 }))).kind,
    "uncertain",
  );
  const { calls, port: refused } = onPort(() => json(200, {}));
  assert.equal(
    (
      await refused.library.decideSuggestion(
        ws,
        PROPOSAL,
        command({ decision: "accept", digest: "nope" }),
      )
    ).kind,
    "invalid",
  );
  assert.equal(calls.length, 0);
});

test("the fixture: the Owner writes and deletes, an Admin writes, a member neither", async () => {
  const owner = createFixtureAdapter("ready");
  const view = async (port) => (await port.library.knowledge(ws)).value;
  assert.deepEqual((await view(owner)).may, { write: true, delete: true });
  // One brand voice per shop.
  const voice = await owner.library.addKnowledge(
    ws,
    command({ pageKind: "brand_voice", title: "Voice two", text: "Loud.", note: "" }),
  );
  assert.equal(voice.kind, "conflict");
  const added = await owner.library.addKnowledge(
    ws,
    command({ pageKind: "policy", title: "Gift wrap", text: "Free in December.", note: "" }),
  );
  assert.equal(added.kind, "ok");
  const { pageId } = added.value;
  // Edits are made at the version read; a stale one changes nothing.
  const page = (await owner.library.knowledgePage(ws, pageId)).value;
  assert.equal(page.version, 1);
  const edited = await owner.library.editKnowledge(
    ws,
    pageId,
    command({ title: "Gift wrap", text: "Free all year.", note: "", expectedVersion: 1 }),
  );
  assert.deepEqual(edited.value, { version: 2 });
  const late = await owner.library.editKnowledge(
    ws,
    pageId,
    command({ title: "Gift wrap", text: "Never.", note: "", expectedVersion: 1 }),
  );
  assert.equal(late.kind, "conflict");
  assert.equal((await owner.library.knowledgePage(ws, pageId)).value.text, "Free all year.");
  // A suggestion is decided on the digest the person saw.
  const suggestion = (await view(owner)).items.find((i) => i.kind === "suggested");
  const wrong = await owner.library.decideSuggestion(
    ws,
    suggestion.id,
    command({ decision: "accept", digest: "0".repeat(64) }),
  );
  assert.equal(wrong.kind, "conflict");
  const accepted = await owner.library.decideSuggestion(
    ws,
    suggestion.id,
    command({ decision: "accept", digest: suggestion.digest }),
  );
  assert.deepEqual(accepted.value, { decision: "accept" });
  const after = await view(owner);
  assert.equal(
    after.items.some((i) => i.kind === "suggested"),
    false,
  );
  assert.ok(after.items.some((i) => i.kind === "fact" && i.title === suggestion.title));
  // The deletion path: at the version read, and the page is gone.
  assert.equal(
    (await owner.library.deleteKnowledge(ws, pageId, command({ expectedVersion: 1 }))).kind,
    "conflict",
  );
  assert.equal(
    (await owner.library.deleteKnowledge(ws, pageId, command({ expectedVersion: 2 }))).kind,
    "ok",
  );
  assert.equal((await owner.library.knowledgePage(ws, pageId)).kind, "not_found");

  const admin = createFixtureAdapter("team_admin");
  assert.deepEqual((await view(admin)).may, { write: true, delete: false });
  const voicePage = (await view(admin)).items.find((i) => i.pageKind === "brand_voice");
  assert.equal(
    (await admin.library.deleteKnowledge(ws, voicePage.id, command({ expectedVersion: 2 }))).kind,
    "denied",
  );
  const member = createFixtureAdapter("team_member");
  assert.deepEqual((await view(member)).may, { write: false, delete: false });
  assert.equal(
    (
      await member.library.addKnowledge(
        ws,
        command({ pageKind: "decision", title: "x", text: "y", note: "" }),
      )
    ).kind,
    "denied",
  );
});

// Enough of the app's services for a screen rendered to markup (no effect runs there).
const markupServices = {
  navigate() {},
  setDirty() {},
  subscribe: () => () => {},
  version: () => 0,
};
const markup = (view) =>
  renderToStaticMarkup(
    h(
      ServicesProvider,
      { value: markupServices },
      h(KnowledgeBody, { workspaceId: ws, view, reload() {} }),
    ),
  );

test("the screen: typed text only, never customer details; only what the server allows", async () => {
  const owner = (await createFixtureAdapter("ready").library.knowledge(ws)).value;
  const html = markup(owner);
  assert.ok(html.includes(k.typedOnly), "typed-only notice");
  assert.match(k.typedOnly, /customer details/);
  assert.ok(html.includes(k.add));
  assert.ok(html.includes(`aria-label="${k.edit("Brand voice")}"`));
  assert.ok(html.includes(`aria-label="${k.remove("Brand voice")}"`));
  assert.ok(html.includes(k.version(2)));
  // No upload control: uploads wait for their deletion path (P09.T05).
  assert.doesNotMatch(html, /type="file"|upload/i);
  const member = (await createFixtureAdapter("team_member").library.knowledge(ws)).value;
  const read = markup(member);
  assert.ok(read.includes(k.typedOnly));
  assert.ok(!read.includes(k.add));
  assert.ok(!read.includes(`aria-label="${k.edit("Brand voice")}"`));
  assert.ok(!read.includes(`aria-label="${k.remove("Brand voice")}"`));
  const admin = (await createFixtureAdapter("team_admin").library.knowledge(ws)).value;
  const write = markup(admin);
  assert.ok(write.includes(`aria-label="${k.edit("Brand voice")}"`));
  assert.ok(!write.includes(`aria-label="${k.remove("Brand voice")}"`));
});
