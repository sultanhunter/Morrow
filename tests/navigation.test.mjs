import test from "node:test";
import assert from "node:assert/strict";
import { read } from "../scripts/foundation.mjs";
import {
  buildWorkspacePath,
  matchWorkspacePath,
  routeAncestry,
  workspaceRoutes,
} from "../packages/contracts/src/routes.ts";

// P02.A01 route fixtures, run through the one matcher (`@morrow/contracts/routes`,
// P14.T01a §4.3) against the reviewed catalogue and its generated subset.
const catalogue = read("docs/contracts/workspace-routes.json");
test("route inventory has unique IDs/patterns and valid parents", () => {
  const ids = catalogue.routes.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(catalogue.routes.map((r) => r.pattern)).size, ids.length);
  for (const r of catalogue.routes) {
    assert.ok(r.parent === null || ids.includes(r.parent));
    assert.ok(r.components.length && r.data.length);
  }
});
test("the generated route subset equals the reviewed catalogue", () => {
  assert.equal(workspaceRoutes.version, catalogue.version);
  assert.deepEqual(
    workspaceRoutes.routes.map((r) => JSON.stringify(r)),
    catalogue.routes.map((r) =>
      JSON.stringify({
        id: r.id,
        pattern: r.pattern,
        title: r.title,
        hosts: r.hosts,
        parent: r.parent,
        ...(r.parameter_enums ? { parameter_enums: r.parameter_enums } : {}),
      }),
    ),
  );
});
for (const r of catalogue.routes)
  test("round trip canonical route " + r.id, () => {
    const params = Object.fromEntries(
      [...r.pattern.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => [
        m[1],
        r.parameter_enums?.[m[1]]?.[0] ?? "opaque:123",
      ]),
    );
    const host = r.hosts[0];
    const url = buildWorkspacePath(catalogue, r.id, params, host);
    assert.deepEqual(matchWorkspacePath(catalogue, url, host), { id: r.id, params });
    assert.deepEqual(matchWorkspacePath(workspaceRoutes, url, host), { id: r.id, params });
  });
test("root case: / matches only the account route, and nothing else matches it", () => {
  assert.deepEqual(matchWorkspacePath(catalogue, "/"), { id: "account", params: {} });
  assert.equal(buildWorkspacePath(catalogue, "account", {}), "/");
  for (const path of ["//", "/?x", "/#x", "", "/w", "/w/", "/account"])
    assert.notEqual(matchWorkspacePath(catalogue, path)?.id, "account", path);
  assert.equal(matchWorkspacePath(catalogue, "/", "operator_console"), null);
  assert.throws(() => buildWorkspacePath(catalogue, "account", { workspaceId: "w" }));
});
test("static builder route wins over dynamic agent route", () =>
  assert.equal(matchWorkspacePath(catalogue, "/w/workspace-1/agents/new").id, "builder"));
test("reserved static slug cannot masquerade as an agent identity", () =>
  assert.throws(
    () =>
      buildWorkspacePath(catalogue, "agent", { workspaceId: "workspace-1", installationId: "new" }),
    /ROUTE_PARAMETERS_INVALID/,
  ));
test("builder draft resolves its exact detail rather than an installation", () =>
  assert.equal(
    matchWorkspacePath(catalogue, "/w/workspace-1/agents/drafts/draft-1").id,
    "builder_draft",
  ));
for (const host of ["shopify_admin", "shopify_connector", "operator_console"])
  test("merchant domain URLs deny surface " + host, () => {
    assert.equal(matchWorkspacePath(catalogue, "/w/workspace-1/work/task-1", host), null);
    assert.throws(
      () =>
        buildWorkspacePath(
          catalogue,
          "task",
          { workspaceId: "workspace-1", taskId: "task-1" },
          host,
        ),
      /ROUTE_SURFACE_DENIED/,
    );
  });
for (const path of [
  "/w/workspace-1/work/a%2Fb",
  "/w/workspace-1/work/%2e%2e",
  "/w/workspace-1/work/%FF",
  "/w/a/../b",
  "//external.example",
  "https://external.example",
  "/w/workspace-1/work/task-1?token=abc",
  "/w/workspace-1/work/task-1#other",
  "/w/workspace-1/settings/api-key",
  "/operator/releases",
])
  test("reject unsafe/unscoped path " + path, () =>
    assert.equal(matchWorkspacePath(catalogue, path), null),
  );
test("URL params cannot inject a redirect, store change or credential", () => {
  assert.throws(
    () =>
      buildWorkspacePath(catalogue, "task", {
        workspaceId: "workspace-1",
        taskId: "task-1",
        token: "secret",
      }),
    /ROUTE_PARAMETERS_INVALID/,
  );
  assert.throws(
    () =>
      buildWorkspacePath(catalogue, "task", { workspaceId: "workspace-1", taskId: "../store-2" }),
    /ROUTE_PARAMETERS_INVALID/,
  );
});
test("task URL contains stable identity rather than navigation store", () =>
  assert.equal(
    buildWorkspacePath(catalogue, "task", { workspaceId: "workspace-1", taskId: "task-1" }),
    "/w/workspace-1/work/task-1",
  ));
test("ancestry follows parents to the destination", () => {
  assert.deepEqual(routeAncestry(catalogue, "question"), ["question", "inbox"]);
  assert.deepEqual(routeAncestry(catalogue, "task"), ["task", "work"]);
});
