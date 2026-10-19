import test from "node:test";
import assert from "node:assert/strict";
import { routeTitle, workspaceRoutes } from "../packages/contracts/src/routes.ts";
import { createRouter, readLocation } from "../apps/workspace-web/src/router.ts";
import {
  clearIntended,
  intendedStorageKey,
  isIntendedPath,
  storeIntended,
  takeIntended,
} from "../apps/workspace-web/src/intended-route.ts";
import {
  intendedOnExpiry,
  screenTitle,
  workspace401Decision,
} from "../apps/workspace-web/src/app.tsx";
import { MemoryStorage, ThrowingStorage, fakeWindow } from "./fixtures/workspace-web.mjs";

// P14.T01a AC03 (routing) and AC04 (intended route), on a fake History window.
test("AC03: implemented routes match through the one matcher; queries and fragments are NotFound", () => {
  const at = (pathname, search = "", hash = "") => readLocation({ pathname, search, hash }).match;
  assert.equal(at("/").id, "account");
  assert.equal(at("/w/ws-1").id, "home");
  assert.equal(at("/w/ws-1/work").id, "work");
  assert.deepEqual(at("/w/ws-1/work/t-1"), {
    id: "task",
    params: { workspaceId: "ws-1", taskId: "t-1" },
  });
  assert.equal(at("/w/ws-1/inbox").id, "inbox");
  assert.equal(at("/w/ws-1/inbox/questions/q-1").id, "question");
  for (const [pathname, search, hash] of [
    ["/w/ws-1", "?scenario=ready", ""],
    ["/w/ws-1", "", "#x"],
    ["/operator/releases", "", ""],
    ["/w/ws-1/work/a%2Fb", "", ""],
    ["/nope", "", ""],
    ["//x", "", ""],
  ])
    assert.equal(at(pathname, search, hash), null, pathname + search + hash);
});
test("AC03: document titles come only from route titles, never record text", () => {
  for (const route of workspaceRoutes.routes) {
    const title = routeTitle(workspaceRoutes, route.id);
    assert.ok(typeof title === "string" && title.length > 0 && title.length <= 40, route.id);
  }
});
test("AC03: push, back and forward restore the logical path; a blocked pop re-pushes and asks", () => {
  const win = fakeWindow("/w/ws-1");
  let blocking = false;
  const asked = [];
  const router = createRouter(win, { blocking: () => blocking }, (request) => asked.push(request));
  const seen = [];
  router.subscribe(() => seen.push(router.state().path));
  const before = router.signal();
  assert.equal(router.navigate("/w/ws-1/work"), true);
  assert.equal(before.aborted, true, "a navigation aborts the previous reads");
  assert.equal(router.state().match.id, "work");
  win.back();
  assert.equal(router.state().path, "/w/ws-1");
  router.navigate("/w/ws-1/inbox");
  blocking = true;
  assert.equal(router.navigate("/w/ws-1/work"), false);
  assert.deepEqual(asked.at(-1), { target: "/w/ws-1/work", replace: false });
  win.back();
  assert.equal(router.state().path, "/w/ws-1/inbox", "the guard keeps the page");
  assert.equal(win.location.pathname, "/w/ws-1/inbox", "popstate re-pushed the current path");
  assert.deepEqual(asked.at(-1), { target: "/w/ws-1", replace: false });
  assert.equal(router.navigate("/w/ws-1", { force: true }), true);
  assert.equal(router.state().path, "/w/ws-1");
  assert.deepEqual(seen, ["/w/ws-1/work", "/w/ws-1", "/w/ws-1/inbox", "/w/ws-1"]);
  assert.equal(router.navigate("https://evil.example/"), false);
  assert.equal(router.navigate("//evil.example/"), false);
  router.dispose();
  assert.equal(win.listenerCount("popstate"), 0);
});
test("AC04: only validated /w/ paths are stored, and taking one deletes it", () => {
  const storage = new MemoryStorage();
  storeIntended("/w/ws-1/work/t-1", storage);
  assert.equal(storage.getItem(intendedStorageKey), "/w/ws-1/work/t-1");
  assert.equal(takeIntended(storage), "/w/ws-1/work/t-1");
  assert.equal(storage.getItem(intendedStorageKey), null);
  assert.equal(takeIntended(storage), null, "read once");
  for (const planted of [
    "https://evil.example",
    "//evil",
    "/w/W/../x",
    "/w/W/./x",
    "/",
    "/w/ws-1?next=//evil",
    "/w/ws-1#x",
    "/w/a%2Fb",
    "/w/ws-1/settings/api-key",
    "/operator/releases",
    "javascript:alert(1)",
    "/w/ws-1\\evil",
  ]) {
    storage.setItem(intendedStorageKey, planted);
    assert.equal(takeIntended(storage), null, planted);
    assert.equal(storage.getItem(intendedStorageKey), null, planted);
    assert.equal(isIntendedPath(planted), false, planted);
    storeIntended(planted, storage);
    assert.equal(storage.getItem(intendedStorageKey), null, "store refuses " + planted);
  }
  assert.equal(isIntendedPath("/w/a%3Ab/work"), true, "an encoded Id colon is a valid segment");
  storeIntended("/w/ws-1", storage);
  clearIntended(storage);
  assert.equal(storage.length, 0);
});
test("blocked storage never throws", () => {
  const blocked = new ThrowingStorage();
  storeIntended("/w/ws-1", blocked);
  assert.equal(takeIntended(blocked), null);
  clearIntended(blocked);
  assert.equal(takeIntended(null), null);
});
test("AC06: one failed restore shows WorkspaceUnavailable; later 401s ask for sign-in; no loop", () => {
  // PR-1 (account list not composed): the first 401 after a restore is "unavailable".
  assert.equal(
    workspace401Decision({ overviewComposed: false, restored: { consumed: false } }),
    "workspace_unavailable",
  );
  assert.equal(
    workspace401Decision({ overviewComposed: false, restored: { consumed: true } }),
    "expire",
  );
  assert.equal(workspace401Decision({ overviewComposed: false, restored: null }), "expire");
  // PR-2 (composed): one GET /workspaces probe decides.
  assert.equal(
    workspace401Decision({ overviewComposed: true, restored: { consumed: false } }),
    "probe",
  );
  // The current path becomes the intended route unless it was just restored and never
  // entered: a restore whose bootstrap failed is dropped (no loop).
  const task = "/w/ws-1/work/t-1";
  assert.equal(intendedOnExpiry(task, null), task);
  assert.equal(intendedOnExpiry(task, { path: task, consumed: false }), null);
  assert.equal(intendedOnExpiry("/w/ws-1/inbox", { path: task, consumed: false }), "/w/ws-1/inbox");
  // AC30 resume: once the restored task was entered, a later expiry on it stores it again.
  assert.equal(intendedOnExpiry(task, { path: task, consumed: true }), task);
});
test("AC03: document.title is each screen's own heading or its route title", () => {
  const home = { id: "home", params: { workspaceId: "ws-1" } };
  const view = (session, match = home, entryFailed = false) =>
    screenTitle({ session, match, entryFailed });
  assert.equal(view("expired"), "Sign in to continue");
  assert.equal(view("workspace_unavailable"), "This workspace isn't available to you");
  assert.equal(view("probe_failed"), "This workspace couldn't load");
  assert.equal(view("signed_out"), "You're signed out");
  assert.equal(view("sign_out_unconfirmed"), "We couldn't confirm you were signed out");
  assert.equal(view("active"), "Home");
  assert.equal(view("active", home, true), "This workspace couldn't load");
  assert.equal(view("active", null), "Page not found");
  assert.equal(
    view("active", { id: "account", params: {} }),
    routeTitle(workspaceRoutes, "account"),
  );
});
