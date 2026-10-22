// M2 PR-3: the catalogue routes of the workspace API in Node (packages/work/src/catalog/
// http.ts). Every guard and closed-variable refusal is decided before any SQL connection
// opens; a passing request runs the session's authority, the store association, the human
// kernel (view on catalog.products.read on the store resource) and the read lease in one
// transaction, then one broker read under that lease, decoded by the protocol's closed
// decoder. A denial sends no lease statement and no broker call; the api Worker sends
// exactly the catalogue paths here. lab:shopify-connect-workers drives the same routes
// through workerd against PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { apiDispatch } from "../apps/api/src/worker.ts";
import {
  catalogPathPattern,
  catalogRoutes,
  catalogVariables,
  createCatalogApiHandler,
} from "../packages/work/src/catalog/http.ts";
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
