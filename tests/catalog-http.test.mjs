// M2 PR-3: the catalogue routes of the workspace API in Node (packages/work/src/catalog/
// http.ts). Every guard and closed-variable refusal is decided before any SQL connection
// opens; a passing request runs the session's authority, the store association, the human
// kernel (view on catalog.products.read on the store resource) and the read lease in one
// transaction, then one broker read under that lease, decoded by the protocol's closed
// decoder. A denial sends no lease statement and no broker call; the api Worker sends
// exactly the catalogue paths here. The api's broker reader (createBrokerShopifyReader:
// closed inputs, the budget-plus-250-ms race, the result size) is unit-tested below and
// the deployed composition in tests/managed-workspace-composition.test.mjs.
// lab:shopify-privacy runs the same handler in Node against PostgreSQL 17 over psql
// bridges (T1-T7, U4); no workerd lab drives the catalogue routes yet.
import test from "node:test";
import assert from "node:assert/strict";
import { createBrokerShopifyReader } from "../apps/api/src/broker-client.ts";
import { apiDispatch } from "../apps/api/src/worker.ts";
import { shopifyReadLimits } from "../packages/identity/src/broker-protocol.ts";
import {
  catalogGuardOptions,
  catalogPathPattern,
  catalogRoutes,
  catalogVariables,
  createCatalogApiHandler,
} from "../packages/work/src/catalog/http.ts";
import {
  WorkGuardError,
  guardWorkspaceRequest,
  workspaceGuardLimits,
} from "../packages/work/src/http-guard.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import {
  validateCurrentDefinition,
  validateDefinition,
} from "../packages/contracts/src/validation.ts";
import { workGuardOrigin, workGuardSecret } from "./fixtures/work-guard-cases.mjs";

const ctx = { waitUntil() {} };
const O = "org_o",
  W = "ws_w",
  S = "store_a",
  C = "connection_a";
const lease = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const readHeaders = (overrides = {}) => ({
  Cookie: "__Host-morrow_session=" + workGuardSecret,
  "Sec-Fetch-Site": "same-origin",
  ...overrides,
});
function request(method, path, headers = readHeaders(), body) {
  const h = new Headers();
  for (const [name, value] of Object.entries(headers)) if (value !== null) h.set(name, value);
  return new Request(workGuardOrigin + path, { method, headers: h, body });
}
const products = `/workspace/${W}/stores/${S}/catalog/products`;
const collections = `/workspace/${W}/stores/${S}/catalog/collections`;
const owner = {
  kind: "human",
  principalId: "person_a",
  organizationId: O,
  workspaceId: W,
  membershipId: "membership_a",
  installationId: null,
  mandateId: null,
};
const storeGrant = (capabilityId, verbs, overrides = {}) => ({
  id: "grant_" + capabilityId.replaceAll(".", "_"),
  principal: owner,
  capabilityId,
  verbs,
  scope: {
    organizationId: O,
    workspaceId: W,
    storeIds: [S],
    accountIds: [],
    resources: [storeResource(O, W, S, C)],
    fields: [...listingFieldPaths],
  },
  issuedBy: { ...owner, kind: "service", principalId: "morrow.linking", membershipId: null },
  validFrom: "2026-10-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  policyRevision: 1,
  ...overrides,
});
// A scripted work connection: the prologue, enter_context, the store association, the
// read lease and COMMIT, recording every statement name it was sent.
function scripted({ grants, association = true, lease: leaseRow } = {}) {
  const sent = [];
  const names = new Map(Object.entries(workStatements).map(([name, text]) => [text, name]));
  const connection = {
    async query(text, values) {
      const name = names.get(text) ?? text;
      sent.push([name, values]);
      if (name === "enterContext")
        return {
          rows: [
            {
              principal_id: owner.principalId,
              organization_id: O,
              workspace_id: W,
              membership_id: owner.membershipId,
              policy_revision: "1",
              grants: JSON.stringify(grants),
              grant_count: String(grants.length),
              grants_digest: "a".repeat(64),
              database_now_us: String(Date.UTC(2026, 9, 22) * 1000),
            },
          ],
        };
      if (name === "storeAssociation")
        return {
          rows: association
            ? [{ store_id: S, connection_id: C, database_now: "2026-10-22T00:00:00.000Z" }]
            : [],
        };
      if (name === "catalogReadLease")
        return {
          rows: [
            leaseRow ?? {
              outcome: "opened",
              lease_id: lease,
              generation: "1",
              expires_at_ms: "1",
              subject_id: "subject_1",
            },
          ],
        };
      return { rows: [] };
    },
    async close() {},
  };
  return { sent, connector: { open: async () => connection } };
}
const readAll = (reply) => {
  const reads = [];
  return {
    reads,
    reader: {
      async read(l, queryName, variablesJson, signal, budgetMs) {
        reads.push({ l, queryName, variables: JSON.parse(variablesJson), budgetMs });
        if (reply instanceof Error) throw reply;
        return typeof reply === "function" ? reply(queryName) : reply;
      },
    },
  };
};
const quiet = async (t, body) => {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  const result = await body();
  return { result, lines };
};
async function expectEnvelope(response, status, name) {
  assert.equal(response.status, status, name);
  const body = await response.json();
  assert.ok(validateDefinition("core", "ErrorEnvelope", body), name);
  assert.equal(response.headers.has("set-cookie"), false, name);
  assert.equal(response.headers.get("cache-control"), "no-store", name);
  return body;
}

test("the route table and dispatch: two GET routes under /stores, sent here and nowhere else", () => {
  assert.deepEqual(
    catalogRoutes.map((r) => [r.method, r.pattern, r.path, [...r.query], r.queryName]),
    [
      [
        "GET",
        "/:storeId/catalog/collections",
        "/stores/:storeId/catalog/collections",
        ["after"],
        "collectionsPage",
      ],
      [
        "GET",
        "/:storeId/catalog/products",
        "/stores/:storeId/catalog/products",
        ["after", "collectionId", "query"],
        "productsPage",
      ],
    ],
  );
  for (const path of [products, collections, `/workspace/${W}/stores/${S}/catalog/x`])
    assert.equal(apiDispatch(path), "catalog", path);
  assert.equal(apiDispatch(`/workspace/${W}/stores/${S}/agents/listings`), "agents");
  assert.equal(apiDispatch(`/workspace/${W}/stores/${S}/catalogue`), "workspace");
  assert.ok(!catalogPathPattern.test(`/workspace/${W}/work/goals`));
});

test("guard and variable refusals are decided before any SQL connection opens", async (t) => {
  let opens = 0;
  const handler = createCatalogApiHandler({
    origin: workGuardOrigin,
    connector: {
      open: async () => {
        opens++;
        throw Error("NO_DATABASE");
      },
    },
    now: Date.now,
    reader: readAll("{}").reader,
  });
  const cases = [
    [
      "post",
      "POST",
      products,
      readHeaders({ Origin: workGuardOrigin, "Content-Type": "application/json" }),
      405,
    ],
    ["no_cookie", "GET", products, readHeaders({ Cookie: null }), 401],
    ["foreign_origin", "GET", products, readHeaders({ Origin: "https://evil.example.test" }), 403],
    ["cross_site", "GET", products, readHeaders({ "Sec-Fetch-Site": "cross-site" }), 403],
    ["content_type", "GET", products, readHeaders({ "Content-Type": "application/json" }), 400],
    ["unknown_param", "GET", products + "?limit=5", readHeaders(), 400],
    ["repeated_param", "GET", products + "?after=a&after=b", readHeaders(), 400],
    [
      "collection_and_query",
      "GET",
      products + "?collectionId=collection:1&query=shirt",
      readHeaders(),
      400,
    ],
    [
      "bad_collection",
      "GET",
      products + "?collectionId=gid://shopify/Collection/1",
      readHeaders(),
      400,
    ],
    ["bad_cursor", "GET", products + "?after=has%20space", readHeaders(), 400],
    ["search_syntax", "GET", products + "?query=title:x%20OR%20y", readHeaders(), 400],
    ["collections_query", "GET", collections + "?query=x", readHeaders(), 400],
    ["bad_store", "GET", `/workspace/${W}/stores/%20/catalog/products`, readHeaders(), 400],
    ["unknown_tail", "GET", `/workspace/${W}/stores/${S}/catalog/products/1`, readHeaders(), 404],
  ];
  await quiet(t, async () => {
    for (const [name, method, path, headers, status] of cases)
      await expectEnvelope(
        await handler.fetch(request(method, path, headers), undefined, ctx),
        status,
        name,
      );
  });
  assert.equal(opens, 0);
  // Without a reader (a broker that serves no reads), nothing opens either.
  const unread = createCatalogApiHandler({
    origin: workGuardOrigin,
    connector: { open: async () => assert.fail("opened") },
    now: Date.now,
    reader: null,
  });
  const { result } = await quiet(t, () => unread.fetch(request("GET", products), undefined, ctx));
  await expectEnvelope(result, 503, "no reader");
  // The unbound handler: 401 with no I/O.
  const { result: unbound } = await quiet(t, () =>
    createCatalogApiHandler().fetch(request("GET", products), undefined, ctx),
  );
  await expectEnvelope(unbound, 401, "unbound");
  assert.equal(
    catalogVariables(catalogRoutes[1], new Map([["query", "linen shirt"]])),
    '{"after":null,"collectionId":null,"search":"linen shirt"}',
  );
});

test("a read: kernel, lease and one broker read under it; closed results only", async (t) => {
  const grants = [storeGrant("catalog.products.read", ["view", "delegate"])];
  const db = scripted({ grants });
  const reply = (queryName) =>
    JSON.stringify(
      queryName === "productsPage"
        ? {
            schemaVersion: 1,
            outcome: "read",
            products: [{ id: "product:1", title: "Shirt", status: "active" }],
            nextCursor: "abc",
          }
        : {
            schemaVersion: 1,
            outcome: "read",
            collections: [{ id: "collection:5", title: "Summer" }],
            nextCursor: null,
          },
    );
  const r = readAll(reply);
  const handler = createCatalogApiHandler({
    origin: workGuardOrigin,
    connector: db.connector,
    now: Date.now,
    reader: r.reader,
  });
  const { result, lines } = await quiet(t, () =>
    handler.fetch(request("GET", products + "?query=Shirt&after=xyz"), undefined, ctx),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    schemaVersion: 1,
    products: [{ id: "product:1", title: "Shirt", status: "active" }],
    nextCursor: "abc",
    storeId: S,
  });
  assert.deepEqual(
    db.sent.map(([name]) => name),
    ["prologueReadWrite", "enterContext", "storeAssociation", "catalogReadLease", "commit"],
  );
  assert.deepEqual(db.sent[3][1], [S, C]);
  assert.equal(r.reads.length, 1);
  assert.deepEqual(r.reads[0].l, { leaseId: lease, generation: 1, subjectId: "subject_1" });
  assert.equal(r.reads[0].queryName, "productsPage");
  assert.deepEqual(r.reads[0].variables, { after: "xyz", collectionId: null, search: "Shirt" });
  assert.ok(r.reads[0].budgetMs >= 1 && r.reads[0].budgetMs <= 15000);
  assert.deepEqual(JSON.parse(lines[0]).outcome, "read");
  const { result: page } = await quiet(t, () =>
    handler.fetch(request("GET", collections), undefined, ctx),
  );
  assert.deepEqual((await page.json()).collections, [{ id: "collection:5", title: "Summer" }]);
});

test("a page cursor of up to 1,536 characters crosses the guard percent-encoded; a longer one is 400 (M2 PR-3 review)", async (t) => {
  const grants = [storeGrant("catalog.products.read", ["view"])];
  // A title-sorted cursor: base64 of JSON holding the last node's title (here 255 4-byte
  // characters), with the +, / and = that a client percent-encodes.
  const cursor = Buffer.from(
    JSON.stringify({ last_id: 98765432101234, last_value: "\u{1F600}".repeat(255) }),
  ).toString("base64");
  assert.ok(cursor.length <= shopifyReadLimits.cursorMaxChars && cursor.length > 512);
  const maximal = "+/=A".repeat(shopifyReadLimits.cursorMaxChars / 4);
  for (const after of [cursor, maximal]) {
    const db = scripted({ grants });
    const r = readAll(
      JSON.stringify({ schemaVersion: 1, outcome: "read", products: [], nextCursor: after }),
    );
    const handler = createCatalogApiHandler({
      origin: workGuardOrigin,
      connector: db.connector,
      now: Date.now,
      reader: r.reader,
    });
    const query = new URLSearchParams({
      after,
      collectionId: "collection:12345678901234567890",
    }).toString();
    const { result } = await quiet(t, () =>
      handler.fetch(request("GET", products + "?" + query), undefined, ctx),
    );
    assert.equal(result.status, 200);
    assert.equal((await result.json()).nextCursor, after);
    assert.deepEqual(r.reads[0].variables, {
      after,
      collectionId: "collection:12345678901234567890",
      search: null,
    });
  }
  // One character more: 400 before any SQL connection.
  let opens = 0;
  const handler = createCatalogApiHandler({
    origin: workGuardOrigin,
    connector: {
      open: async () => {
        opens++;
        throw Error("NO_DATABASE");
      },
    },
    now: Date.now,
    reader: readAll("{}").reader,
  });
  const { result } = await quiet(t, () =>
    handler.fetch(
      request("GET", collections + "?after=" + "A".repeat(shopifyReadLimits.cursorMaxChars + 1)),
      undefined,
      ctx,
    ),
  );
  await expectEnvelope(result, 400, "cursor_too_long");
  assert.equal(opens, 0);
});

test("the guard's query-value and URL limits: defaults unchanged, raised only by the catalogue's options", async () => {
  const guard = (path, options) =>
    guardWorkspaceRequest(
      workGuardOrigin,
      "stores",
      catalogRoutes,
      request("GET", path),
      new AbortController().signal,
      options,
    ).then(
      (g) => g.query.get("after"),
      (error) => {
        if (!(error instanceof WorkGuardError)) throw error;
        return error.status;
      },
    );
  const at = (n) => collections + "?after=" + "A".repeat(n);
  // Every other route family keeps 512 characters a value and 2,048 a URL.
  assert.equal(await guard(at(512)), "A".repeat(512));
  assert.equal(await guard(at(513)), 400);
  assert.equal(await guard(at(513), catalogGuardOptions), "A".repeat(513));
  assert.equal(await guard(at(1536), catalogGuardOptions), "A".repeat(1536));
  assert.equal(await guard(at(1537), catalogGuardOptions), 400);
  // Percent-encoded at worst (three characters a byte): within the catalogue's URL limit.
  const encoded = collections + "?after=" + "%2B".repeat(1536);
  assert.ok(encoded.length > workspaceGuardLimits.urlChars);
  assert.equal(await guard(encoded), 400);
  assert.equal(await guard(encoded, catalogGuardOptions), "+".repeat(1536));
  // Options outside the guard's ceilings are a configuration error, not a request error.
  for (const options of [
    { ...catalogGuardOptions, queryValueMaxChars: 0 },
    { ...catalogGuardOptions, queryValueMaxChars: workspaceGuardLimits.queryValueMaxChars + 1 },
    { ...catalogGuardOptions, urlMaxChars: workspaceGuardLimits.urlChars - 1 },
    { ...catalogGuardOptions, urlMaxChars: workspaceGuardLimits.urlMaxChars + 1 },
    { ...catalogGuardOptions, urlMaxChars: 4096.5 },
  ])
    await assert.rejects(() => guard(at(1), options), /WORKSPACE_ROUTE_LIMIT_INVALID/);
});

test("denials send no lease and no read; a broker failure or a malformed reply is 503", async (t) => {
  const view = storeGrant("catalog.products.read", ["view"]);
  for (const [name, options, status, statements] of [
    // A grant without view, a grant on another store, no grant at all: denied by the kernel.
    ["no_view", { grants: [storeGrant("catalog.products.read", ["delegate"])] }, 403, 2],
    [
      "other_store",
      {
        grants: [
          storeGrant("catalog.products.read", ["view"], {
            scope: {
              ...view.scope,
              storeIds: ["store_b"],
              resources: [storeResource(O, W, "store_b", "connection_b")],
            },
          }),
        ],
      },
      403,
      2,
    ],
    ["no_grant", { grants: [] }, 403, 2],
    ["no_store", { grants: [view], association: false }, 404, 2],
    [
      "stopped",
      {
        grants: [view],
        lease: {
          outcome: "stopped",
          lease_id: null,
          generation: null,
          expires_at_ms: null,
          subject_id: null,
        },
      },
      409,
      3,
    ],
    [
      "connection_changed",
      {
        grants: [view],
        lease: {
          outcome: "not_found",
          lease_id: null,
          generation: null,
          expires_at_ms: null,
          subject_id: null,
        },
      },
      404,
      3,
    ],
  ]) {
    const db = scripted(options);
    const r = readAll("{}");
    const handler = createCatalogApiHandler({
      origin: workGuardOrigin,
      connector: db.connector,
      now: Date.now,
      reader: r.reader,
    });
    const { result } = await quiet(t, () =>
      handler.fetch(request("GET", products), undefined, ctx),
    );
    await expectEnvelope(result, status, name);
    assert.equal(r.reads.length, 0, name);
    assert.equal(
      db.sent.filter(([n]) => !["prologueReadWrite", "commit", "rollback"].includes(n)).length,
      statements,
      name,
    );
  }
  for (const [name, reply, status] of [
    ["broker_held", Error("API_BROKER_HELD"), 503],
    ["malformed", "{}", 503],
    [
      "extra_field",
      JSON.stringify({
        schemaVersion: 1,
        outcome: "read",
        products: [],
        nextCursor: null,
        vendor: "x",
      }),
      503,
    ],
    ["not_found", JSON.stringify({ schemaVersion: 1, outcome: "not_found" }), 404],
  ]) {
    const db = scripted({ grants: [view] });
    const handler = createCatalogApiHandler({
      origin: workGuardOrigin,
      connector: db.connector,
      now: Date.now,
      reader: readAll(reply).reader,
    });
    const { result } = await quiet(t, () =>
      handler.fetch(request("GET", products), undefined, ctx),
    );
    await expectEnvelope(result, status, name);
  }
  assert.ok(validateCurrentDefinition("Grant", view));
});

test("the api's broker reader: closed inputs, the budget plus 250 ms, a bounded result, never retried", async () => {
  const calls = [];
  const broker = (reply) => ({
    shopifyRead: (...args) => {
      calls.push(args);
      return typeof reply === "function" ? reply() : reply;
    },
  });
  const leaseRef = { leaseId: lease, generation: 3, subjectId: "subject_9" };
  const signal = new AbortController().signal;
  const ok = JSON.stringify({
    schemaVersion: 1,
    outcome: "read",
    collections: [],
    nextCursor: null,
  });
  // The six RPC arguments, in order, and the text returned as is.
  assert.equal(
    await createBrokerShopifyReader(broker(ok)).read(
      leaseRef,
      "collectionsPage",
      '{"after":null}',
      signal,
      4000,
    ),
    ok,
  );
  assert.deepEqual(calls, [[lease, 3, "subject_9", "collectionsPage", '{"after":null}', 4000]]);
  // A budget out of range or variables over the limit: refused before any RPC.
  calls.length = 0;
  const reader = createBrokerShopifyReader(broker(ok));
  for (const [variables, budget] of [
    ['{"after":null}', 0],
    ['{"after":null}', shopifyReadLimits.budgetMaxMs + 1],
    ['{"after":null}', 1.5],
    ["x".repeat(shopifyReadLimits.variablesMaxBytes + 1), 1000],
  ])
    await assert.rejects(
      () => reader.read(leaseRef, "collectionsPage", variables, signal, budget),
      /API_BROKER_HELD/,
    );
  assert.equal(calls.length, 0);
  // An oversized or non-text result is refused.
  for (const reply of ["x".repeat(shopifyReadLimits.resultMaxBytes + 1), 42, null])
    await assert.rejects(
      () =>
        createBrokerShopifyReader(broker(reply)).read(
          leaseRef,
          "collectionsPage",
          '{"after":null}',
          signal,
          1000,
        ),
      /API_BROKER_HELD/,
    );
  // A broker that never answers is abandoned at the budget plus 250 ms, once; an aborted
  // caller is refused at once.
  calls.length = 0;
  const hanging = createBrokerShopifyReader(broker(() => new Promise(() => {})));
  const started = Date.now();
  await assert.rejects(
    () => hanging.read(leaseRef, "collectionsPage", '{"after":null}', signal, 50),
    /API_BROKER_HELD/,
  );
  const waited = Date.now() - started;
  assert.ok(waited >= 290 && waited < 5000, String(waited));
  assert.equal(calls.length, 1);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => hanging.read(leaseRef, "collectionsPage", '{"after":null}', aborted.signal, 1000),
    /API_BROKER_HELD/,
  );
  assert.equal(calls.length, 1);
});
