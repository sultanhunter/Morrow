// T7 PR 19: the project screens (ADR-0033, ADR-0034) behind their default-off switch.
// The HTTP build composes none of `projects.*` and `plans.*` and sends nothing for them;
// the fixture composes them only in its preview scenarios. The plan start is two
// commands bound to the digest shown and consumed once; the screens compute no value or
// word; and request bodies carry no authority.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "../apps/workspace-web/src/http/client.ts";
import { createHttpPort } from "../apps/workspace-web/src/http/api.ts";
import { composed, loginBodyVersion } from "../apps/workspace-web/src/http/composed.ts";
import {
  createFixtureAdapter,
  fixtureComposedFor,
} from "../apps/workspace-web/src/fixtures/adapter.ts";
import {
  projectsComposedIn,
  scenarioNames,
  teammateIn,
} from "../apps/workspace-web/src/fixtures/scenarios.ts";
import { fixtureWorkspace } from "../apps/workspace-web/src/fixtures/seed.ts";
import { portMethods, projectPortMethods } from "../packages/workspace-ui/src/port.ts";
import { ServicesProvider } from "../packages/workspace-ui/src/services.tsx";
import {
  bucketRows,
  byEndDate,
  formatDay,
  healthStyle,
  parseDay,
  statusStyle,
} from "../packages/workspace-ui/src/projects/format.ts";
import { documentBinds } from "../packages/workspace-ui/src/projects/plan-start.tsx";
import { PlanCard, PlanChangeCard, planEdits } from "../packages/workspace-ui/src/projects/plan-card.tsx";
import {
  localToday,
  validAsk,
  validEnd,
  validGoal,
  validTitle,
} from "../packages/workspace-ui/src/projects/new-project.tsx";
import { taskHomes } from "../packages/workspace-ui/src/projects/new-task.tsx";
import { ProjectsTab } from "../packages/workspace-ui/src/projects/projects-tab.tsx";
import { RepeatingTab } from "../packages/workspace-ui/src/projects/repeating-tab.tsx";
import { TasksTab } from "../packages/workspace-ui/src/projects/tasks-tab.tsx";
import { ProjectOverview } from "../packages/workspace-ui/src/projects/project-sections.tsx";
import { HealthWord } from "../packages/workspace-ui/src/projects/parts.tsx";
import { json, recordingTransport } from "./fixtures/workspace-web.mjs";

// The test runner compiles TSX with the classic runtime (no root tsconfig), so React is a
// global before any component renders; no module here builds JSX at load time.
globalThis.React = React;
const h = React.createElement;
const ws = fixtureWorkspace.id;
let keys = 0;
const key = () => `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;
const cmd = (body) => ({ key: key(), body });

/** A minimal services object: enough for screens rendered once on the server. */
function services(port, composedTable) {
  return {
    port,
    composed: composedTable,
    loginBodyVersion: 2,
    fixture: true,
    navigate() {},
    openAccount() {},
    setDirty() {},
    read: (_key, load) => load(),
    newCommand: (body) => ({ key: key(), body }),
    runCommand: (_c, _m, send) => send(),
    releaseCommand() {},
    reentryMarkers: () => [],
    dismissMarker() {},
    subscribe: () => () => {},
    version: () => 0,
    startSignIn: async () => "failed",
    signOut() {},
    challenge: () => ({ token: async () => null, reset() {}, remove() {} }),
  };
}
function render(element, scenario = "projects_preview") {
  const port = createFixtureAdapter(scenario);
  return renderToStaticMarkup(
    h(ServicesProvider, { value: services(port, fixtureComposedFor(scenario)) }, element),
  );
}

test("the switch: every projects and plans method is uncomposed over HTTP and sends nothing", async () => {
  assert.equal(projectPortMethods.length, 17);
  for (const method of projectPortMethods) {
    assert.ok(portMethods.includes(method), method);
    assert.equal(composed[method], false, method);
  }
  // Even composed by mistake, the HTTP adapter has no route for them: not_in_build, no request.
  const recorded = recordingTransport(() => json(200, {}));
  const everything = Object.fromEntries(portMethods.map((m) => [m, true]));
  const port = createHttpPort({
    client: createClient({ transport: recorded.transport, online: () => true }),
    composed: everything,
    loginBodyVersion,
    navigationSignal: () => undefined,
  });
  const c = cmd({});
  for (const method of projectPortMethods) {
    const [namespace, name] = method.split(".");
    const outcome = await port[namespace][name]("ws-1", "id-1", c, c);
    assert.deepEqual(outcome, { kind: "not_in_build" }, method);
  }
  assert.equal(recorded.calls.length, 0);
});

test("the switch: the fixture composes them only in the projects preview scenarios", async () => {
  assert.deepEqual(projectsComposedIn, [
    "projects_preview",
    "projects_teammate",
    "projects_start_stale",
    "projects_start_uncertain",
  ]);
  const ready = fixtureComposedFor("ready");
  for (const scenario of scenarioNames) {
    const table = fixtureComposedFor(scenario);
    for (const method of projectPortMethods)
      assert.equal(table[method], projectsComposedIn.includes(scenario), `${scenario} ${method}`);
  }
  // The preview changes nothing else in the build.
  for (const scenario of projectsComposedIn)
    for (const method of portMethods.filter((m) => !projectPortMethods.includes(m)))
      assert.equal(fixtureComposedFor(scenario)[method], ready[method], `${scenario} ${method}`);
  assert.ok(teammateIn.every((s) => projectsComposedIn.includes(s)));
  // Off, the fixture's methods answer not_in_build, and no scenario calls fetch.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => {
    calls++;
    return original(...args);
  };
  try {
    assert.deepEqual(await createFixtureAdapter("ready").projects.overview(ws), {
      kind: "not_in_build",
    });
    for (const scenario of projectsComposedIn) {
      const port = createFixtureAdapter(scenario);
      assert.equal((await port.projects.overview(ws)).kind, "ok", scenario);
      await port.plans.conversation(ws, "conv-sample");
      await port.projects.get(ws, "project-tote");
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});

test("days, words and orders: formatted, never computed", () => {
  assert.equal(formatDay("2026-12-04"), "Fri, Dec 4");
  assert.equal(formatDay("2026-11-16"), "Mon, Nov 16");
  // Anything that isn't a real day renders as given.
  for (const raw of ["2026-02-30", "2026-13-01", "Dec 4", "", "2026-12-4"]) {
    assert.equal(parseDay(raw), null, raw);
    assert.equal(formatDay(raw), raw);
  }
  // Badge words carry a glyph and a tone; plain words have none; unknown words are text.
  assert.equal(healthStyle({ word: "on_track", reason: null }).tone, "success");
  assert.equal(healthStyle({ word: "behind", reason: null }).glyph, "alert");
  assert.equal(healthStyle({ word: "needs_you", reason: null }).tone, "caution");
  for (const word of ["not_checked_yet", "starting_point", "not_started", "not_measured"])
    assert.equal(healthStyle({ word, reason: null }).tone, null, word);
  assert.deepEqual(healthStyle({ word: "a_future_word", reason: null }), {
    label: "a_future_word",
    tone: null,
    glyph: "circle",
  });
  assert.equal(statusStyle("cancelled").glyph, "minus");
  assert.equal(statusStyle("x_new").label, "x_new");
  // Dated projects by end date, ties by title.
  const row = (title, endsOn) => ({ title, endsOn });
  assert.deepEqual(
    byEndDate([row("B", "2026-12-04"), row("A", "2026-11-16"), row("A2", "2026-12-04")]).map(
      (r) => r.title,
    ),
    ["A", "A2", "B"],
  );
  // The board keeps every row: an unknown bucket gets its own column, Mine filters.
  const t = (taskId, bucket, mine) => ({ taskId, bucket, mine });
  const groups = bucketRows([t("1", "to_do", true), t("2", "later", false), t("3", "working", false)], false);
  assert.deepEqual(
    groups.map((g) => [g.bucket, g.rows.map((r) => r.taskId)]),
    [
      ["needs_you", []],
      ["to_do", ["1"]],
      ["working", ["3"]],
      ["done_today", []],
      ["later", ["2"]],
    ],
  );
  assert.deepEqual(
    bucketRows([t("1", "to_do", true), t("2", "later", false)], true).flatMap((g) =>
      g.rows.map((r) => r.taskId),
    ),
    ["1"],
  );
});

test("forms: closed values, checked before anything is sent", () => {
  assert.ok(validTitle("Winter scarves launch"));
  assert.ok(!validTitle("   "));
  assert.ok(!validTitle("x".repeat(121)));
  assert.ok(!validTitle("a\0b"));
  assert.ok(validGoal("40 scarves sold by Dec 31"));
  assert.ok(!validGoal("x".repeat(2049)));
  assert.ok(validAsk("Get the Linen Shirt into AI answers"));
  assert.ok(!validAsk(""));
  assert.ok(!validAsk("x".repeat(16385)));
  assert.ok(validEnd("2026-12-04", "2026-10-23"));
  assert.ok(!validEnd("2026-10-23", "2026-10-23"), "today is not after today");
  assert.ok(!validEnd("2026-02-30", "2026-01-01"));
  assert.match(localToday(new Date(2026, 9, 3)), /^2026-10-03$/);
});

test("the plan start binds the digest shown, the target and the project, and expires", () => {
  const digest = "a".repeat(64);
  const doc = {
    documentDigest: "b".repeat(64),
    nonce: "n".repeat(32),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    target: "project",
    draftDigest: digest,
    projectId: null,
  };
  const expected = { target: "project", draftDigest: digest, projectId: null };
  assert.equal(documentBinds(doc, expected), "binds");
  assert.equal(documentBinds({ ...doc, draftDigest: "c".repeat(64) }, expected), "mismatch");
  assert.equal(documentBinds({ ...doc, target: "finish" }, expected), "mismatch");
  assert.equal(documentBinds({ ...doc, projectId: "project-1" }, expected), "mismatch");
  assert.equal(documentBinds({ ...doc, documentDigest: "XYZ" }, expected), "mismatch");
  assert.equal(documentBinds({ ...doc, nonce: "short" }, expected), "mismatch");
  assert.equal(
    documentBinds({ ...doc, expiresAt: new Date(Date.now() - 1).toISOString() }, expected),
    "expired",
  );
  assert.equal(documentBinds({ ...doc, expiresAt: "not a time" }, expected), "expired");
  // Finish binds a code-built card: no draft digest, the project it closes.
  assert.equal(
    documentBinds(
      { ...doc, target: "finish", draftDigest: null, projectId: "project-summer" },
      { target: "finish", draftDigest: null, projectId: "project-summer" },
    ),
    "binds",
  );
});

test("the fixture's plan start: one document per digest, consumed once, stale after an edit", async () => {
  const port = createFixtureAdapter("projects_preview");
  const read = async () => {
    const conversation = await port.plans.conversation(ws, "conv-sample");
    assert.equal(conversation.kind, "ok");
    return conversation.value.messages.find((m) => m.kind === "plan").card;
  };
  const card = await read();
  assert.equal(card.started, null);
  assert.equal(card.kind, "project");
  // A digest the server doesn't hold is stale: no document.
  const wrong = await port.plans.startDocument(ws, cmd({ messageId: card.messageId, draftDigest: "d".repeat(64) }));
  assert.equal(wrong.kind, "conflict");
  // Edit makes a new revision with a new digest; the old one is now stale.
  const revised = await port.plans.revise(
    ws,
    "conv-sample",
    cmd({
      messageId: card.messageId,
      draftDigest: card.draftDigest,
      edits: planEdits(card, {
        title: "Linen Shirt on AI answers",
        endsOn: "2026-12-11",
        keepGoals: [card.goals[0].key],
        keepSteps: card.steps.map((s) => s.index),
      }),
    }),
  );
  assert.equal(revised.kind, "ok");
  assert.notEqual(revised.value.draftDigest, card.draftDigest);
  const old = await port.plans.startDocument(ws, cmd({ messageId: card.messageId, draftDigest: card.draftDigest }));
  assert.equal(old.kind, "conflict");
  const edited = await read();
  assert.equal(edited.title, "Linen Shirt on AI answers");
  assert.equal(edited.endsOn, "2026-12-11");
  assert.equal(edited.goals.length, 1);
  // The document for the digest held binds it, and is consumed once.
  const document = await port.plans.startDocument(
    ws,
    cmd({ messageId: edited.messageId, draftDigest: edited.draftDigest }),
  );
  assert.equal(document.kind, "ok");
  assert.equal(
    documentBinds(document.value, { target: "project", draftDigest: edited.draftDigest, projectId: null }),
    "binds",
  );
  const wrongNonce = await port.plans.start(ws, cmd({ documentDigest: document.value.documentDigest, nonce: "x".repeat(32) }));
  assert.equal(wrongNonce.kind, "conflict");
  const started = await port.plans.start(
    ws,
    cmd({ documentDigest: document.value.documentDigest, nonce: document.value.nonce }),
  );
  assert.equal(started.kind, "ok");
  const reused = await port.plans.start(
    ws,
    cmd({ documentDigest: document.value.documentDigest, nonce: document.value.nonce }),
  );
  assert.equal(reused.kind, "conflict", "a document is used once");
  // The card now says it started (derived), and can't start again.
  const after = await read();
  assert.equal(after.started.projectId, started.value.projectId);
  const again = await port.plans.startDocument(ws, cmd({ messageId: after.messageId, draftDigest: after.draftDigest }));
  assert.equal(again.kind, "conflict");
  const project = await port.projects.get(ws, started.value.projectId);
  assert.equal(project.kind, "ok");
  assert.equal(project.value.title, "Linen Shirt on AI answers");
});

test("Finish: a code-built document under the person's revision, then its single use", async () => {
  const port = createFixtureAdapter("projects_preview");
  const project = (await port.projects.get(ws, "project-summer")).value;
  assert.equal(project.state, "ended");
  assert.equal(project.actions.finish, true);
  const stale = await port.projects.finishDocument(
    ws,
    "project-summer",
    cmd({ keepRepeating: true, expectedRevision: project.revision - 1 }),
  );
  assert.equal(stale.kind, "conflict");
  const document = await port.projects.finishDocument(
    ws,
    "project-summer",
    cmd({ keepRepeating: true, expectedRevision: project.revision }),
  );
  assert.equal(document.kind, "ok");
  assert.equal(
    documentBinds(document.value, { target: "finish", draftDigest: null, projectId: "project-summer" }),
    "binds",
  );
  const done = await port.plans.start(
    ws,
    cmd({ documentDigest: document.value.documentDigest, nonce: document.value.nonce }),
  );
  assert.equal(done.kind, "ok");
  const overview = (await port.projects.overview(ws)).value;
  assert.ok(overview.finished.some((f) => f.projectId === "project-summer"));
  assert.ok(!overview.dated.some((r) => r.projectId === "project-summer"));
  // Stop steps and Extend also carry the revision they were shown.
  const tote = (await port.projects.get(ws, "project-tote")).value;
  assert.equal(
    (await port.projects.stopSteps(ws, "project-tote", cmd({ expectedRevision: tote.revision + 1 }))).kind,
    "conflict",
  );
  const stopped = await port.projects.stopSteps(ws, "project-tote", cmd({ expectedRevision: tote.revision }));
  assert.equal(stopped.kind, "ok");
  assert.ok((await port.projects.get(ws, "project-tote")).value.stopped);
});

test("a teammate's actions are off as the server says, and creating is refused", async () => {
  const port = createFixtureAdapter("projects_teammate");
  const tote = (await port.projects.get(ws, "project-tote")).value;
  assert.deepEqual(Object.values(tote.actions), [false, false, false, false, false, false]);
  const overview = (await port.projects.overview(ws)).value;
  assert.equal(overview.actions.create, false);
  assert.equal(
    (await port.projects.create(ws, cmd({ title: "X", endsOn: "2026-12-04", goal: "Y" }))).kind,
    "denied",
  );
  // The teammate's own Ask still starts (only the asker may), with the specialist step
  // left to the Owner.
  const card = (await port.plans.conversation(ws, "conv-sample")).value.messages.find(
    (m) => m.kind === "plan",
  ).card;
  assert.equal(card.canStart, true);
  assert.ok(card.helpers.some((helper) => helper.note?.startsWith("Only Maya (Owner)")));
});

test("request bodies carry ids, digests, revisions, text and closed choices only", () => {
  const allowed = new Set([
    "conversationId",
    "text",
    "title",
    "endsOn",
    "goal",
    "goalId",
    "objective",
    "expectedRevision",
    "keepRepeating",
    "messageId",
    "draftDigest",
    "edits",
    "answer",
    "mentionMorrow",
    "documentDigest",
    "nonce",
    "kind",
    "optionId",
  ]);
  const dir = "packages/workspace-ui/src/projects";
  let bodies = 0;
  for (const file of readdirSync(dir)) {
    const source = readFileSync(`${dir}/${file}`, "utf8");
    // Every object literal handed to a command: submit({...}), begin({...}), answer({...}).
    for (const match of source.matchAll(/\b(?:submit|begin|answer)\(\{([^}]*)\}/g)) {
      bodies++;
      // Each property is `key: value` or a shorthand `key`; a nested call's arguments (the
      // closed `planEdits(card, form)`) are its own, so the scan stops at the first call.
      const body = match[1].split("(")[0];
      for (const part of body.split(",").map((p) => p.trim()).filter(Boolean)) {
        const name = /^([A-Za-z_]\w*)\s*(?::|$)/.exec(part)?.[1];
        assert.ok(name !== undefined && allowed.has(name), `${file}: ${part}`);
      }
      assert.doesNotMatch(match[1], /workspace|tenant|actor|grant|role|capability|scope|credit/i);
    }
  }
  assert.ok(bodies >= 10, String(bodies));
});

test("screens: the Projects tab, Tasks and Repeating render from the sample, by end date", async () => {
  const port = createFixtureAdapter("projects_preview");
  const overview = (await port.projects.overview(ws)).value;
  const html = render(h(ProjectsTab, { ws, overview }));
  for (const text of ["Projects with an end date", "Everyday work", "Finished", "Quick tasks"])
    assert.ok(html.includes(text), text);
  const at = (title) => html.indexOf(title);
  assert.ok(at("Summer linen clearance") < at("Autumn collection"));
  assert.ok(at("Autumn collection") < at("Black Friday sale"));
  assert.ok(at("Black Friday sale") < at("Everyday Tote in AI answers"));
  assert.ok(html.includes("/w/ws-linen/projects/area-stock"));
  // New task files tasks in a goal record of a project, area or Quick tasks.
  assert.deepEqual(taskHomes(overview).at(-1), { goalId: "goal-area-quick", label: "Quick tasks" });
  const tasks = (await port.projects.tasks(ws)).value;
  const board = render(h(TasksTab, { ws, tasks, canCreate: false, onNewTask() {} }));
  assert.ok(board.includes("Needs you") && board.includes("Done today"));
  assert.ok(!board.includes("New task"), "hidden without the server's createTask action");
  assert.ok(board.includes("/w/ws-linen/work/task-pj-reorder"), "a task opens on its task page");
  const repeating = render(h(RepeatingTab, { ws, view: (await port.projects.repeating(ws)).value }));
  assert.ok(repeating.includes("Waiting for you to turn on"));
  assert.ok(!/>Turn on</.test(repeating), "turning on waits for its review gate");
});

test("screens: health words are a glyph and a word, plain words have no badge", () => {
  const badge = render(h(HealthWord, { health: { word: "on_track", reason: null } }));
  assert.match(badge, /pj-badge pj-badge-success/);
  assert.match(badge, /aria-hidden="true"/);
  assert.match(badge, />On track</);
  const plain = render(h(HealthWord, { health: { word: "not_checked_yet", reason: null } }));
  assert.doesNotMatch(plain, /pj-badge/);
  assert.match(plain, />Not checked yet</);
});

test("screens: a plan card says who wrote it, shows taint above Start, and starts only for the asker", async () => {
  const port = createFixtureAdapter("projects_preview");
  const card = (await port.plans.conversation(ws, "conv-sample")).value.messages.find(
    (m) => m.kind === "plan",
  ).card;
  const props = { ws, conversationId: "conv-sample", onChanged() {} };
  const open = render(h(PlanCard, { ...props, card }));
  assert.match(open, />Start project</);
  assert.match(open, />Edit</);
  assert.match(open, />Not now</);
  assert.ok(open.includes(card.visibility));
  const tainted = render(
    h(PlanCard, { ...props, card: { ...card, tainted: "Parts of this plan came from a check-up report." } }),
  );
  assert.ok(tainted.indexOf("came from a check-up report") < tainted.indexOf(">Start project<"));
  const notAsker = render(
    h(PlanCard, {
      ...props,
      card: { ...card, canStart: false, startNote: "Only Maya Chen, who asked, can start this plan." },
    }),
  );
  assert.doesNotMatch(notAsker, />Start project</);
  assert.match(notAsker, /Only Maya Chen, who asked/);
  const started = render(
    h(PlanCard, { ...props, card: { ...card, started: { projectId: "project-1", note: "Started by Maya Chen" } } }),
  );
  assert.doesNotMatch(started, />Start project</);
  assert.match(started, /\/w\/ws-linen\/projects\/project-1/);
  // With the switch off nothing can start, even a card that says it may.
  assert.doesNotMatch(render(h(PlanCard, { ...props, card }), "ready"), />Start project</);
  const change = render(
    h(PlanChangeCard, {
      ws,
      projectId: "project-tote",
      card: {
        messageId: "m-1",
        draftDigest: "a".repeat(64),
        title: "Morrow suggests 1 change to the plan",
        intro: null,
        changes: [{ kind: "add", title: "Ask 5 buyers for a review", owner: null, detail: null }],
        because: null,
        credits: null,
        tainted: null,
        started: null,
        canStart: true,
        startNote: null,
      },
      onChanged() {},
    }),
  );
  assert.match(change, />Written by Morrow</);
  assert.match(change, />Apply changes</);
});

test("screens: an Everyday work area shows its goal, alerts and repeating tasks", async () => {
  const port = createFixtureAdapter("projects_preview");
  const stock = (await port.projects.get(ws, "area-stock")).value;
  assert.equal(stock.kind, "area");
  const html = render(h(ProjectOverview, { ws, project: stock }));
  for (const text of ["Alerts on this goal", "Repeating tasks", "Who works here", "Spend this month"])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes("No best seller under 2 weeks of stock"));
  const tote = (await port.projects.get(ws, "project-tote")).value;
  const dated = render(h(ProjectOverview, { ws, project: tote }));
  for (const text of ["Since you were last here", "Goals", "Plan", "Latest update", "Credits"])
    assert.ok(dated.includes(text), text);
});
