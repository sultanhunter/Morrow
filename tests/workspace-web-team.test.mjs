// T7 PR 16: Team, agent pages, Add agents, Settings, Shop knowledge and Files. The port
// group is uncomposed over HTTP (it sends nothing: the default-off switch), the fixture
// models the rules the screens must respect (who may change how a helper thinks, a stale
// revision, an add document bound to its fingerprint and used once, Shopify access asked
// for), the thinking options follow the catalogue and its ceiling, the characters carry no
// colour literal, and the copy holds none of ADR-0032 item 4's internal words. No browser
// and no network; `npm run ui:check` renders the screens.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "../apps/workspace-web/src/http/client.ts";
import { createHttpPort } from "../apps/workspace-web/src/http/api.ts";
import { composed, loginBodyVersion } from "../apps/workspace-web/src/http/composed.ts";
import { createFixtureAdapter } from "../apps/workspace-web/src/fixtures/adapter.ts";
import { scenarioNames } from "../apps/workspace-web/src/fixtures/scenarios.ts";
import { fixtureWorkspace } from "../apps/workspace-web/src/fixtures/seed.ts";
import { portMethods } from "../packages/workspace-ui/src/port.ts";
import {
  activityFilters,
  isStopConfirmation,
  monthlyLimitRange,
  optionsFromCatalogue,
  optionsFromEstimates,
  sameNotificationChoices,
  stopAllState,
  teamPortMethods,
  thinkingEfforts,
  thinkingModels,
} from "../packages/workspace-ui/src/team-model.ts";
import { settingsRoutes } from "../packages/workspace-ui/src/sunrise/parts.tsx";
import { workspaceRoutes } from "../packages/contracts/src/routes.ts";
import { sunriseCopy } from "../packages/workspace-ui/src/sunrise/copy.ts";
import { AgentAvatar, PersonAvatar } from "../packages/workspace-ui/src/sunrise/avatars.tsx";
import { recordingTransport } from "./fixtures/workspace-web.mjs";

// tsx compiles the components' JSX with the classic runtime here: React must be in scope.
globalThis.React = React;
const h = React.createElement;
const ws = fixtureWorkspace.id;
const command = (body) => ({ key: randomUUID(), body });

test("the port: thirteen methods, none composed over HTTP, and none sends a request", async () => {
  assert.equal(teamPortMethods.length, 13);
  for (const method of teamPortMethods) {
    assert.ok(portMethods.includes(method), method);
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
  const outcomes = [
    await port.team.overview(ws),
    await port.team.agent(ws, "agent-listings"),
    await port.team.reviseThinking(
      ws,
      "morrow",
      command({ model: "claude_opus_5_5", effort: "high", expectedRevision: 1 }),
    ),
    await port.team.catalogue(ws),
    await port.team.addDocument(
      ws,
      "release-marketing",
      command({ model: "claude_sonnet_5_5", effort: "low", monthlyCreditLimit: 200 }),
    ),
    await port.team.addConfirm(
      ws,
      "release-marketing",
      command({ documentDigest: "a".repeat(64), nonce: "b".repeat(64) }),
    ),
    await port.settings.plan(ws),
    await port.settings.emailAddresses(ws),
    await port.library.knowledge(ws),
    await port.library.files(ws),
    await port.settings.notifications(ws),
    await port.settings.reviseNotifications(
      ws,
      command({
        email: { soon: true, summary: true, monday: false, mentions: true },
        summaryHour: 8,
        quiet: { on: true, from: 21, until: 7 },
        timeZone: "toronto",
        expectedRevision: 1,
      }),
    ),
    await port.settings.activity(ws),
  ];
  assert.deepEqual(
    outcomes.map((o) => o.kind),
    Array(13).fill("not_in_build"),
  );
  assert.equal(recorded.calls.length, 0);
});

test("the fixture: Team as the Owner, with Listings on the workspace model default", async () => {
  const port = createFixtureAdapter("ready");
  const team = await port.team.overview(ws);
  assert.equal(team.kind, "ok");
  const view = team.value;
  assert.equal(view.viewerRole, "owner");
  assert.deepEqual(
    view.agents.map((a) => a.character),
    ["listings", "business_analyst", "inventory", "support"],
  );
  const models = await port.models.list(ws);
  const listings = view.agents[0].thinking;
  assert.equal(listings.source, "workspace_default");
  assert.equal(listings.model, models.value.workspaceDefault.model);
  assert.equal(listings.effort, models.value.workspaceDefault.effort);
  // ADR-0027 item 12's defaults: Morrow Opus 5.5 high, specialists Opus 5.5 medium,
  // added agents Sonnet 5.5 low.
  assert.deepEqual(
    [view.morrow.thinking.model, view.morrow.thinking.effort],
    ["claude_opus_5_5", "high"],
  );
  assert.deepEqual(
    [view.specialistDefault.model, view.specialistDefault.effort],
    ["claude_opus_5_5", "medium"],
  );
  for (const agent of view.agents.slice(1)) {
    assert.equal(agent.thinking.source, "own");
    assert.deepEqual([agent.thinking.model, agent.thinking.effort], ["claude_sonnet_5_5", "low"]);
  }
  const page = await port.team.agent(ws, "agent-listings");
  assert.equal(page.kind, "ok");
  assert.equal(page.value.permission.grantedBy, "Maya Chen");
  assert.ok(page.value.permissions.never.includes("Change prices"));
  assert.equal((await port.team.agent(ws, "agent-nobody")).kind, "not_found");
  assert.equal((await port.team.overview("ws-other")).kind, "not_found");
});

test("thinking: the Owner changes any helper, an Admin added agents only, a member none", async () => {
  const body = { model: "claude_haiku_5_5", effort: "medium", expectedRevision: 1 };
  const expect = {
    ready: { morrow: "ok", specialists: "ok", "agent-analyst": "ok" },
    team_admin: { morrow: "denied", specialists: "denied", "agent-analyst": "ok" },
    team_member: { morrow: "denied", specialists: "denied", "agent-analyst": "denied" },
  };
  for (const [scenario, targets] of Object.entries(expect)) {
    const port = createFixtureAdapter(scenario);
    const view = (await port.team.overview(ws)).value;
    // The view says what the server will allow; the screen only shows it.
    assert.equal(view.morrow.thinking.canChange, targets.morrow === "ok", scenario);
    assert.equal(view.specialistDefault.canChange, targets.specialists === "ok", scenario);
    assert.equal(view.agents[1].thinking.canChange, targets["agent-analyst"] === "ok", scenario);
    for (const [target, kind] of Object.entries(targets))
      assert.equal(
        (await port.team.reviseThinking(ws, target, command(body))).kind,
        kind,
        `${scenario} ${target}`,
      );
  }
});

test("thinking: a stale revision changes nothing, a repeat key replays, keys are closed", async () => {
  const port = createFixtureAdapter("ready");
  const stale = await port.team.reviseThinking(
    ws,
    "agent-support",
    command({ model: "claude_opus_5_5", effort: "high", expectedRevision: 0 }),
  );
  assert.equal(stale.kind, "conflict");
  assert.equal(stale.recheck, true);
  const c = command({ model: "claude_opus_5_5", effort: "medium", expectedRevision: 1 });
  const saved = await port.team.reviseThinking(ws, "agent-support", c);
  assert.deepEqual([saved.kind, saved.value.revision, saved.replayed], ["ok", 2, false]);
  const again = await port.team.reviseThinking(ws, "agent-support", c);
  assert.deepEqual([again.kind, again.value.revision, again.replayed], ["ok", 2, true]);
  const support = (await port.team.overview(ws)).value.agents.find((a) => a.name === "Support");
  assert.deepEqual(
    [support.thinking.model, support.thinking.effort, support.thinking.revision],
    ["claude_opus_5_5", "medium", 2],
  );
  for (const bad of [
    { model: "claude-opus-5-5", effort: "high", expectedRevision: 2 },
    { model: "claude_opus_5_5", effort: "High", expectedRevision: 2 },
  ])
    assert.equal(
      (await port.team.reviseThinking(ws, "agent-support", command(bad))).kind,
      "invalid",
    );
  // The Listings agent's choice is the workspace default: models.reviseDefault, not this.
  assert.equal(
    (
      await port.team.reviseThinking(
        ws,
        "agent-listings",
        command({ model: "claude_haiku_5_5", effort: "low", expectedRevision: 1 }),
      )
    ).kind,
    "not_found",
  );
  // The scenario's 409 is shown as "changed": nothing is saved.
  const conflict = createFixtureAdapter("team_thinking_conflict");
  const first = await conflict.team.reviseThinking(
    ws,
    "morrow",
    command({ model: "claude_sonnet_5_5", effort: "high", expectedRevision: 1 }),
  );
  assert.equal(first.kind, "conflict");
  assert.equal((await conflict.team.overview(ws)).value.morrow.thinking.revision, 1);
});

test("adding: the server's document binds the confirmation, once; access is asked for", async () => {
  const port = createFixtureAdapter("ready");
  const catalogue = (await port.team.catalogue(ws)).value;
  const marketing = catalogue.entries.find((e) => e.releaseId === "release-marketing");
  assert.equal(marketing.addedAs, null);
  assert.deepEqual(marketing.shopifyAccess, [
    "Create and end discount codes, only after you approve",
  ]);
  assert.equal(marketing.reviewer, "Leo Martin");
  const doc = await port.team.addDocument(
    ws,
    "release-marketing",
    command({ model: "claude_sonnet_5_5", effort: "medium", monthlyCreditLimit: 250 }),
  );
  assert.equal(doc.kind, "ok");
  const d = doc.value;
  assert.match(d.documentDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(d.thinking, { model: "claude_sonnet_5_5", effort: "medium" });
  assert.equal(d.monthlyCreditLimit, 250);
  assert.deepEqual(d.shopifyAccess, marketing.shopifyAccess);
  assert.equal(d.reviewer, "Leo Martin");
  // Another document's values, or a changed digest, are refused and change nothing.
  const wrong = await port.team.addConfirm(
    ws,
    "release-marketing",
    command({ documentDigest: d.documentDigest, nonce: "f".repeat(64) }),
  );
  assert.equal(wrong.kind, "conflict");
  const confirmed = await port.team.addConfirm(
    ws,
    "release-marketing",
    command({ documentDigest: d.documentDigest, nonce: d.nonce }),
  );
  assert.deepEqual([confirmed.kind, confirmed.value.status], ["ok", "waiting_review"]);
  const reused = await port.team.addConfirm(
    ws,
    "release-marketing",
    command({ documentDigest: d.documentDigest, nonce: d.nonce }),
  );
  assert.equal(reused.kind, "conflict");
  const after = (await port.team.catalogue(ws)).value.entries.find(
    (e) => e.releaseId === "release-marketing",
  );
  assert.deepEqual([after.waitingReview, after.addedAs], [true, null]);
  // Waiting for review is not added: Team doesn't list it.
  assert.equal((await port.team.overview(ws)).value.agents.length, 4);
});

test("adding: a one-person shop adds at once; members, bad limits and repeats are refused", async () => {
  const solo = createFixtureAdapter("team_solo");
  const doc = (
    await solo.team.addDocument(
      ws,
      "release-marketing",
      command({ model: "claude_sonnet_5_5", effort: "low", monthlyCreditLimit: 200 }),
    )
  ).value;
  assert.equal(doc.reviewer, null);
  const added = await solo.team.addConfirm(
    ws,
    "release-marketing",
    command({ documentDigest: doc.documentDigest, nonce: doc.nonce }),
  );
  assert.deepEqual([added.value.status, added.value.agentId], ["added", "agent-marketing"]);
  const team = (await solo.team.overview(ws)).value;
  assert.equal(team.agents.at(-1).name, "Marketing");
  assert.equal(team.people.length, 1);
  assert.equal(
    (
      await solo.team.addDocument(
        ws,
        "release-marketing",
        command({ model: "claude_sonnet_5_5", effort: "low", monthlyCreditLimit: 200 }),
      )
    ).kind,
    "conflict",
  );
  const owner = createFixtureAdapter("ready");
  for (const limit of [monthlyLimitRange.min - 1, monthlyLimitRange.max + 1, 12.5])
    assert.equal(
      (
        await owner.team.addDocument(
          ws,
          "release-marketing",
          command({ model: "claude_sonnet_5_5", effort: "low", monthlyCreditLimit: limit }),
        )
      ).kind,
      "invalid",
      String(limit),
    );
  assert.equal(
    (
      await owner.team.addDocument(
        ws,
        "release-nothing",
        command({ model: "claude_sonnet_5_5", effort: "low", monthlyCreditLimit: 200 }),
      )
    ).kind,
    "not_found",
  );
  const member = createFixtureAdapter("team_member");
  assert.equal((await member.team.catalogue(ws)).value.canAdd, false);
  assert.equal(
    (
      await member.team.addDocument(
        ws,
        "release-marketing",
        command({ model: "claude_sonnet_5_5", effort: "low", monthlyCreditLimit: 200 }),
      )
    ).kind,
    "denied",
  );
});

test("the add confirmation's lost reply: Check again replays the same key", async () => {
  const port = createFixtureAdapter("team_add_uncertain");
  const doc = (
    await port.team.addDocument(
      ws,
      "release-marketing",
      command({ model: "claude_sonnet_5_5", effort: "low", monthlyCreditLimit: 200 }),
    )
  ).value;
  const c = command({ documentDigest: doc.documentDigest, nonce: doc.nonce });
  assert.equal((await port.team.addConfirm(ws, "release-marketing", c)).kind, "uncertain");
  const replay = await port.team.addConfirm(ws, "release-marketing", c);
  assert.deepEqual([replay.kind, replay.value.status], ["ok", "waiting_review"]);
});

test("thinking options: the catalogue fits within the member ceiling, estimates per job", () => {
  const catalogue = {
    catalogueVersion: 1,
    entries: [
      { model: "claude_haiku_5_5", effort: "low", creditsPerProduct: 1, runProductLimit: 25 },
      { model: "claude_opus_5_5", effort: "high", creditsPerProduct: 6, runProductLimit: 9 },
    ].map((e) => ({ ...e, allowedForMember: true })),
    workspaceDefault: { model: "claude_haiku_5_5", effort: "low" },
    ceiling: 2,
    revision: 3,
    canRevise: true,
    draftingAvailable: true,
  };
  assert.deepEqual(
    optionsFromCatalogue(catalogue).map((o) => [o.model, o.effort, o.unit, o.limit, o.fits]),
    [
      ["claude_haiku_5_5", "low", "product", 2, true],
      ["claude_opus_5_5", "high", "product", 2, false],
    ],
  );
  const estimates = thinkingModels.flatMap((model, m) =>
    thinkingEfforts.map((effort, e) => ({ model, effort, typical: m + e + 1, most: 20 * (m + 1) })),
  );
  const options = optionsFromEstimates({
    model: "claude_sonnet_5_5",
    effort: "low",
    source: "own",
    usual: { model: "claude_sonnet_5_5", effort: "low" },
    revision: 1,
    canChange: true,
    estimates,
    jobLimit: 40,
  });
  assert.equal(options.length, 9);
  assert.deepEqual(
    options.filter((o) => !o.fits).map((o) => o.model),
    ["claude_opus_5_5", "claude_opus_5_5", "claude_opus_5_5"],
  );
  assert.ok(options.every((o) => o.unit === "job" && o.limit === 40));
});

test("settings: one Morrow address, the default; linked mailboxes are reserved kinds", async () => {
  const port = createFixtureAdapter("ready");
  const emails = (await port.settings.emailAddresses(ws)).value;
  assert.deepEqual(
    emails.addresses.map((a) => [a.kind, a.status, a.isDefault]),
    [["morrow_managed", "active", true]],
  );
  assert.deepEqual(emails.linkable, ["google_mailbox", "microsoft_mailbox", "merchant_domain"]);
  assert.equal(emails.viewerIsOwner, true);
  assert.equal(
    (await createFixtureAdapter("team_member").settings.emailAddresses(ws)).value.viewerIsOwner,
    false,
  );
  const plan = (await port.settings.plan(ws)).value;
  assert.equal(plan.creditsLeft + plan.used, plan.monthly);
  assert.equal(plan.extraCredits.enabled, false);
  // The fixture's numbers agree with each other (the Sunrise brief's sample day).
  assert.equal(
    plan.byProject.reduce((n, r) => n + r.credits, 0),
    plan.used,
  );
  const empty = createFixtureAdapter("empty");
  assert.equal((await empty.library.files(ws)).value.files.length, 0);
  assert.equal((await empty.library.knowledge(ws)).value.items.length, 0);
  assert.equal((await empty.team.overview(ws)).value.agents.length, 0);
});

test("settings: each board page has its own section, all within the route contract", () => {
  const route = workspaceRoutes.routes.find((r) => r.id === "settings_section");
  const sections = route.parameter_enums.section;
  const used = Object.values(settingsRoutes).filter((v) => v !== null);
  for (const section of used) assert.ok(sections.includes(section), section);
  assert.equal(new Set(used).size, used.length);
  // Until the contract has `email` and `activity` (the brief's open question 1).
  assert.deepEqual(settingsRoutes, {
    plan: "usage",
    people: "people",
    notifications: "notifications",
    email: "stores",
    shopify: null,
    activity: "governance",
    governance: "billing",
  });
});

const prefsBody = (view, change = {}) => ({
  email: view.email,
  summaryHour: view.summaryHour,
  quiet: view.quiet,
  timeZone: view.timeZone,
  expectedRevision: view.revision,
  ...change,
});
test("notifications: each person's own, closed values; the time zone is the Owner's", async () => {
  const port = createFixtureAdapter("ready");
  const view = (await port.settings.notifications(ws)).value;
  assert.equal(view.canChangeTimeZone, true);
  assert.ok(sameNotificationChoices(view, prefsBody(view)));
  const off = { ...view.email, monday: false };
  assert.ok(!sameNotificationChoices(view, prefsBody(view, { email: off })));
  const save = command(prefsBody(view, { email: off, summaryHour: 9 }));
  const saved = await port.settings.reviseNotifications(ws, save);
  assert.equal(saved.kind, "ok");
  assert.equal(saved.value.revision, view.revision + 1);
  // A repeat of the same key replays; it doesn't save twice.
  const again = await port.settings.reviseNotifications(ws, save);
  assert.deepEqual([again.kind, again.replayed, again.value.revision], ["ok", true, 2]);
  const now = (await port.settings.notifications(ws)).value;
  assert.deepEqual([now.email.monday, now.summaryHour, now.revision], [false, 9, 2]);
  // The old revision is refused: reread, nothing changes.
  const stale = await port.settings.reviseNotifications(
    ws,
    command(prefsBody(view, { summaryHour: 7 })),
  );
  assert.deepEqual([stale.kind, stale.recheck], ["conflict", true]);
  assert.equal((await port.settings.notifications(ws)).value.summaryHour, 9);
  // Values outside the board's lists, or extra keys, are refused.
  for (const change of [
    { summaryHour: 3 },
    { quiet: { on: true, from: 23, until: 7 } },
    { timeZone: "utc" },
    { email: { ...now.email, marketing: true } },
    { email: { ...now.email, soon: "yes" } },
  ]) {
    const refused = await port.settings.reviseNotifications(ws, command(prefsBody(now, change)));
    assert.equal(refused.kind, "invalid", JSON.stringify(change));
  }
  // A member changes their own choices, never the shop's time zone.
  const member = createFixtureAdapter("team_member");
  const theirs = (await member.settings.notifications(ws)).value;
  assert.equal(theirs.canChangeTimeZone, false);
  const zone = await member.settings.reviseNotifications(
    ws,
    command(prefsBody(theirs, { timeZone: "vancouver" })),
  );
  assert.equal(zone.kind, "denied");
  const own = await member.settings.reviseNotifications(
    ws,
    command(prefsBody(theirs, { quiet: { on: false, from: 21, until: 7 } })),
  );
  assert.equal(own.kind, "ok");
  assert.equal((await member.settings.notifications("ws-other")).kind, "not_found");
});

test("activity: who did what, by day; filters are closed; no conversations", async () => {
  const view = (await createFixtureAdapter("ready").settings.activity(ws)).value;
  assert.ok(view.entries.length > 5);
  const categories = new Set(view.entries.map((e) => e.category));
  for (const c of categories) assert.ok([...activityFilters, "work"].includes(c), c);
  assert.ok(!activityFilters.includes("work"));
  for (const e of view.entries) assert.doesNotMatch(e.what + e.detail, /conversation/i);
  assert.equal((await createFixtureAdapter("empty").settings.activity(ws)).value.entries.length, 0);
});

const store = (storeId, shopDomain = `${storeId}.example`) => ({
  installationId: `inst-${storeId}`,
  connectionId: `conn-${storeId}`,
  storeId,
  shopDomain,
  status: "linked",
  grantedScopes: [],
  updatedAt: "2026-10-23T09:00:00.000Z",
});
const listings = (storeId, { on = true, stopped = false, mayStop = true } = {}) => ({
  storeId,
  linked: true,
  blocked: false,
  installation: on
    ? {
        installationId: `listings-${storeId}`,
        status: stopped ? "disabled" : "active",
        revision: 1,
        stopped,
        updatedAt: "2026-10-23T09:00:00.000Z",
      }
    : null,
  actions: { enable: !on, resume: stopped, stop: on && mayStop },
});
test("stop all: only what the server lets this person stop, and not what is stopped", () => {
  const state = stopAllState([
    { connection: store("s1"), listings: listings("s1") },
    { connection: store("s2"), listings: listings("s2", { stopped: true }) },
    { connection: store("s3"), listings: listings("s3", { mayStop: false }) },
    { connection: store("s4"), listings: listings("s4", { on: false }) },
    // A reply for another store than the connection names is ignored.
    { connection: store("s5"), listings: listings("s6") },
  ]);
  assert.deepEqual(state.targets, [
    { storeId: "s1", shopDomain: "s1.example", installationId: "listings-s1" },
  ]);
  assert.equal(state.stopped, 1);
  assert.equal(state.notAllowed, 1);
  assert.deepEqual(stopAllState([]), { targets: [], stopped: 0, notAllowed: 0 });
  // The typed confirmation: the word itself, nothing else.
  for (const typed of ["stop", "STOP", "  Stop "]) assert.ok(isStopConfirmation(typed), typed);
  for (const typed of ["", "stp", "stop now", "s t o p", "stopp"])
    assert.ok(!isStopConfirmation(typed), typed);
});

test("stop all is the Listings stop: one key per store; a lost reply replays that key", async () => {
  const port = createFixtureAdapter("stop_all_uncertain");
  const [connection] = (await port.connections.list(ws)).value.installations;
  const before = (await port.agents.listingsStatus(ws, connection.storeId)).value;
  assert.deepEqual([before.installation.stopped, before.actions.stop], [false, true]);
  const stop = command({ reason: sunriseCopy.stop.reason });
  assert.equal((await port.agents.listingsStop(ws, connection.storeId, stop)).kind, "uncertain");
  const check = await port.agents.listingsStop(ws, connection.storeId, stop);
  assert.deepEqual([check.kind, check.replayed], ["ok", true]);
  const after = (await port.agents.listingsStatus(ws, connection.storeId)).value;
  assert.equal(after.installation.stopped, true);
  assert.deepEqual(stopAllState([{ connection, listings: after }]), {
    targets: [],
    stopped: 1,
    notAllowed: 0,
  });
  // The reason is plain words within the HTTP adapter's bound.
  assert.ok(sunriseCopy.stop.reason.length > 0 && sunriseCopy.stop.reason.length <= 1024);
  // With nothing on (the default sample), there is nothing to stop.
  const ready = createFixtureAdapter("ready");
  const off = (await ready.agents.listingsStatus(ws, connection.storeId)).value;
  assert.deepEqual(stopAllState([{ connection, listings: off }]).targets, []);
});

test("every scenario's reads of the group settle without a request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => {
    calls++;
    return original(...args);
  };
  const settle = (p) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r({ kind: "pending" }), 5))]);
  try {
    for (const scenario of scenarioNames) {
      const port = createFixtureAdapter(scenario);
      for (const read of [
        () => port.team.overview(ws),
        () => port.team.agent(ws, "agent-listings"),
        () => port.team.catalogue(ws),
        () => port.settings.plan(ws),
        () => port.settings.emailAddresses(ws),
        () => port.settings.notifications(ws),
        () => port.settings.activity(ws),
        () => port.library.knowledge(ws),
        () => port.library.files(ws),
      ])
        assert.ok((await settle(read())).kind, scenario);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});

test("characters: no colour literal, a unique clip per use, a label or hidden", () => {
  const characters = [
    "morrow",
    "listings",
    "business_analyst",
    "inventory",
    "support",
    "marketing",
    "specialist",
  ];
  const html = renderToStaticMarkup(
    h(
      "div",
      null,
      ...characters.map((character) => h(AgentAvatar, { key: character, character })),
      h(AgentAvatar, { key: "labelled", character: "listings", label: "Listings" }),
      h(AgentAvatar, { key: "small", character: "support", size: 20 }),
      h(PersonAvatar, { key: "p", initials: "MC", presence: "online" }),
    ),
  );
  assert.doesNotMatch(html, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  const clips = [...html.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(clips.length, 8);
  assert.equal(new Set(clips).size, 8);
  for (const id of clips) {
    assert.match(id, /^sa-clip-[A-Za-z0-9_-]+$/);
    assert.ok(html.includes(`clip-path="url(#${id})"`), id);
  }
  assert.equal((html.match(/aria-hidden="true"/g) ?? []).length >= characters.length, true);
  assert.match(html, /role="img" aria-label="Listings"/);
  // Below 24 px a tile shows the initial, not a drawing.
  assert.match(html, /class="sa-initial sa-support"[^>]*>S</);
  assert.match(html, /, online/);
});

// ADR-0032 item 4: internal terms stay out of the interface.
const banned =
  /\b(?:runs?|tokens?|digests?|mandates?|tool calls?|workflows?|triggers?|webhooks?|queues?|retry|retries|scopes?|api|prompts?|sandbox(?:es)?|artifacts?|releases?|install(?:ed|s|ing)?|coordinator|delegat\w*|threads?)\b/i;
function strings(value, path, out) {
  if (typeof value === "string") out.push([path, value]);
  else if (typeof value === "function") {
    const sample = value(
      ...Array(value.length)
        .fill(0)
        .map((_, i) => (i % 2 ? 3 : "Sample")),
    );
    strings(sample, path + "()", out);
  } else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
  return out;
}
test("copy: plain words, none of the internal terms", () => {
  const all = strings(sunriseCopy, "sunriseCopy", []);
  assert.ok(all.length > 200, String(all.length));
  const hits = all.filter(([, text]) => banned.test(text));
  assert.deepEqual(hits, []);
  // Buttons start with a verb.
  for (const label of [
    sunriseCopy.team.addAgents,
    sunriseCopy.add.confirm,
    sunriseCopy.email.copy,
    sunriseCopy.files.upload,
    sunriseCopy.thinking.save,
  ])
    assert.match(label, /^(Add|Copy|Upload|Save)\b/);
});
