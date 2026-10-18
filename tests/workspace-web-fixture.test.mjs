import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createFixtureAdapter,
  fixtureCanary,
  fixtureComposed,
  fixtureComposedFor,
} from "../apps/workspace-web/src/fixtures/adapter.ts";
import {
  fixtureBootAllowed,
  readScenario,
  scenarioNames,
  scenarioRoot,
} from "../apps/workspace-web/src/fixtures/scenarios.ts";
import { createSeed, fixtureWorkspace } from "../apps/workspace-web/src/fixtures/seed.ts";
import { createPending } from "../apps/workspace-web/src/pending.ts";
import {
  inspectDistFiles,
  inspectModuleReport,
  negativeChecks,
} from "../scripts/workspace-web-checks.mjs";
import { MemoryStorage } from "./fixtures/workspace-web.mjs";

// P14.T01a AC13 (fixture isolation) and the §4.11 scripted fixture adapter.
const ws = fixtureWorkspace.id;
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function exercise(port) {
  const outcomes = [];
  const settle = (p) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r({ kind: "pending" }), 5))]);
  for (const call of [
    () => port.workspace.bootstrap(ws),
    () => port.account.overview(),
    () => port.work.listGoals(ws, null),
    () => port.work.getTask(ws, "task-titles"),
    () => port.work.listMyOpenQuestions(ws, null),
    () => port.work.getAnswer(ws, "q-titles"),
    () => port.work.createGoal(ws, { key: key(1), body: { objective: "x", criteria: ["y"] } }),
    () => port.work.markReady(ws, "task-titles", { key: key(2), body: { expectedRevision: 2 } }),
    () =>
      port.work.answer(ws, "q-source", {
        key: key(3),
        body: { text: "Cite it", expectedRevision: 1 },
      }),
    () => port.session.startSignIn(ws),
    () => port.session.signOut(),
    () => port.people.list(ws),
  ])
    outcomes.push((await settle(call())).kind);
  return outcomes;
}

test("AC13: the fixture adapter never calls fetch, in any scenario", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => {
    calls++;
    return original(...args);
  };
  try {
    for (const scenario of scenarioNames) await exercise(createFixtureAdapter(scenario));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});
test("AC13: fixture-main boots only in a fixture build on a loopback host", () => {
  assert.equal(fixtureBootAllowed("fixture", "127.0.0.1"), true);
  assert.equal(fixtureBootAllowed("fixture", "localhost"), true);
  for (const [mode, host] of [
    ["fixture", "example.test"],
    ["fixture", "w.example"],
    ["production", "127.0.0.1"],
    ["development", "localhost"],
    [undefined, "127.0.0.1"],
  ])
    assert.equal(fixtureBootAllowed(mode, host), false, `${mode} ${host}`);
  const entry = readFileSync("apps/workspace-web/src/fixture-main.tsx", "utf8");
  assert.match(entry, /fixtureBootAllowed\(import\.meta\.env\.MODE, window\.location\.hostname\)/);
  const production = readFileSync("apps/workspace-web/src/main.tsx", "utf8");
  assert.doesNotMatch(production, /from "\.\/fixtures\//);
  assert.doesNotMatch(production, /import\.meta\.env|createFixtureAdapter/);
});
test("AC13: the dist checks catch a planted canary, an unlisted URL and fixture or axe modules", () => {
  for (const check of negativeChecks()) assert.equal(check.passed, true, check.name);
  assert.ok(inspectDistFiles([{ path: "assets/a.js", text: fixtureCanary }]).length > 0);
  assert.ok(
    inspectModuleReport({
      chunks: [
        { fileName: "a.js", isEntry: true, moduleIds: ["node_modules/playwright-core/lib/x.js"] },
      ],
    }).length > 0,
  );
});
test("the Linen & Form seed: one workspace, three goals, six tasks and four questions", () => {
  const seed = createSeed();
  assert.equal(fixtureWorkspace.displayName, "Linen & Form");
  assert.deepEqual([seed.goals.length, seed.tasks.length, seed.questions.length], [3, 6, 4]);
  assert.equal(fixtureComposed["people.list"], false, "Assign and Ask stay hidden in fixtures too");
  assert.equal(fixtureComposed["session.keepAlive"], false);
});
test("scenario uncertain_persisting: uncertain, then a still-in-flight 503, then the replay", async () => {
  const port = createFixtureAdapter("uncertain_persisting");
  const pending = createPending({ storage: new MemoryStorage() });
  const command = { key: key(9), body: { objective: "New goal", criteria: ["Done"] } };
  const run = () =>
    pending.run(command, { workspaceId: ws, kind: "goal" }, () =>
      port.work.createGoal(ws, command),
    );
  assert.equal((await run()).kind, "uncertain");
  assert.equal((await run()).kind, "uncertain");
  const last = await run();
  assert.equal(last.kind, "ok");
  assert.equal(last.replayed, true);
  const goals = await port.work.listGoals(ws, null);
  assert.equal(
    goals.value.items.filter((g) => g.objective === "New goal").length,
    1,
    "applied once",
  );
});
test("scenarios are scripted: denied, partial denial, offline and account variants", async () => {
  assert.equal((await createFixtureAdapter("denied").work.listGoals(ws, null)).kind, "denied");
  const partial = createFixtureAdapter("home_partial_denied");
  assert.equal((await partial.work.listMyOpenQuestions(ws, null)).kind, "denied");
  assert.equal((await partial.work.listGoals(ws, null)).kind, "ok");
  assert.deepEqual(await createFixtureAdapter("offline").work.listGoals(ws, null), {
    kind: "unavailable",
    offline: true,
  });
  assert.equal(
    (await createFixtureAdapter("account_chooser").account.overview()).value.workspaces.length,
    3,
  );
  assert.equal(
    (await createFixtureAdapter("session_expired").workspace.bootstrap(ws)).kind,
    "unauthenticated",
  );
  assert.equal(
    (await createFixtureAdapter("ready").workspace.bootstrap("ws-other")).kind,
    "unauthenticated",
  );
  // Session scenarios (AC06, AC07, AC12).
  const restore = createFixtureAdapter("restore_unavailable");
  assert.equal(fixtureComposedFor("restore_unavailable")["account.overview"], false);
  assert.equal(fixtureComposed["account.overview"], true);
  assert.equal((await restore.account.overview()).kind, "not_in_build", "uncomposed sends nothing");
  assert.equal((await restore.workspace.bootstrap(ws)).kind, "unauthenticated");
  assert.equal(scenarioRoot("restore_unavailable"), "/?scenario=restore_unavailable");
  assert.equal(scenarioRoot("session_expired"), "/");
  const bootstrap = createFixtureAdapter("bootstrap_unavailable");
  assert.equal((await bootstrap.workspace.bootstrap(ws)).kind, "unavailable");
  assert.equal((await bootstrap.workspace.bootstrap(ws)).kind, "ok");
  for (const [scenario, first] of [
    ["sign_out_unavailable", "unavailable"],
    ["sign_out_unknown", "uncertain"],
  ]) {
    const port = createFixtureAdapter(scenario);
    assert.equal((await port.session.signOut()).kind, first, scenario);
    assert.equal((await port.session.signOut()).kind, "ok", scenario);
  }
  const leave = createFixtureAdapter("expire_during_leave");
  assert.equal((await leave.account.overview()).kind, "ok", "the switcher read");
  assert.equal((await leave.account.overview()).kind, "unauthenticated", "the probe");
  assert.equal(readScenario("?scenario=offline"), "offline");
  assert.equal(readScenario("?scenario=<script>"), "ready");
  assert.equal(readScenario(""), "ready");
});
