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
  thinkingFor,
  thinkingModels,
} from "../packages/workspace-ui/src/team-model.ts";
import {
  settingsItems,
  settingsRoutes,
} from "../packages/workspace-ui/src/components/settings-frame.tsx";
import { workspaceRoutes } from "../packages/contracts/src/routes.ts";
import { sunriseCopy } from "../packages/workspace-ui/src/sunrise/copy.ts";
import { AgentAvatar, PersonAvatar } from "../packages/workspace-ui/src/sunrise/avatars.tsx";
import { ServicesProvider } from "../packages/workspace-ui/src/services.tsx";
import { StopAllStatus, stopOutcomeText } from "../packages/workspace-ui/src/screens/stop-all.tsx";
import { MemoryStorage, recordingTransport } from "./fixtures/workspace-web.mjs";
import { createPending } from "../apps/workspace-web/src/pending.ts";
import { copy } from "../packages/workspace-ui/src/copy.ts";

// tsx compiles the components' JSX with the classic runtime here: React must be in scope.
globalThis.React = React;
const h = React.createElement;
const ws = fixtureWorkspace.id;
const command = (body) => ({ key: randomUUID(), body });

test("the port: eighteen methods, none composed over HTTP, and none sends a request", async () => {
  // T7 PR 16's thirteen, and PR 20's five Shop knowledge methods (the shop-knowledge switch).
  assert.equal(teamPortMethods.length, 18);
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
    await port.library.knowledgePage(ws, "11111111-1111-4111-8111-111111111111"),
    await port.library.addKnowledge(
      ws,
      command({ pageKind: "policy", title: "Returns", text: "30 days.", note: "" }),
    ),
    await port.library.editKnowledge(
      ws,
      "11111111-1111-4111-8111-111111111111",
      command({ title: "Returns", text: "30 days.", note: "", expectedVersion: 1 }),
    ),
    await port.library.deleteKnowledge(
      ws,
      "11111111-1111-4111-8111-111111111111",
      command({ expectedVersion: 1 }),
    ),
    await port.library.decideSuggestion(
      ws,
      "22222222-2222-4222-8222-222222222222",
      command({ decision: "accept", digest: "c".repeat(64) }),
    ),
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
    Array(18).fill("not_in_build"),
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
  // The scenario's 409 is a teammate's change: the viewer's choice isn't saved.
  const conflict = createFixtureAdapter("team_thinking_conflict");
  const first = await conflict.team.reviseThinking(
    ws,
    "morrow",
    command({ model: "claude_sonnet_5_5", effort: "high", expectedRevision: 1 }),
  );
  assert.equal(first.kind, "conflict");
  const morrow = (await conflict.team.overview(ws)).value.morrow.thinking;
  assert.deepEqual([morrow.model, morrow.effort], ["claude_haiku_5_5", "medium"]);
});

test("thinking: after a real 409, Team's dialog reads the reread setting and saves its revision", async () => {
  const port = createFixtureAdapter("team_thinking_conflict");
  const target = { kind: "agent", id: "agent-analyst", name: "Business Analyst" };
  const opened = thinkingFor((await port.team.overview(ws)).value, target);
  assert.deepEqual([opened.model, opened.effort, opened.revision], ["claude_sonnet_5_5", "low", 1]);
  const pick = { model: "claude_opus_5_5", effort: "high" };
  // A teammate's change landed first: the server's record moved on.
  const first = await port.team.reviseThinking(
    ws,
    target.id,
    command({ ...pick, expectedRevision: opened.revision }),
  );
  assert.deepEqual([first.kind, first.recheck], ["conflict", true]);
  // The dialog's setting comes from the reread, not from what it opened with.
  const reread = thinkingFor((await port.team.overview(ws)).value, target);
  assert.deepEqual(
    [reread.model, reread.effort, reread.revision],
    ["claude_haiku_5_5", "medium", 2],
  );
  // Sending the opened revision again would conflict for ever; the reread one saves.
  const stale = await port.team.reviseThinking(
    ws,
    target.id,
    command({ ...pick, expectedRevision: opened.revision }),
  );
  assert.equal(stale.kind, "conflict");
  const saved = await port.team.reviseThinking(
    ws,
    target.id,
    command({ ...pick, expectedRevision: reread.revision }),
  );
  assert.deepEqual([saved.kind, saved.value.revision], ["ok", 3]);
  const view = (await port.team.overview(ws)).value;
  const now = thinkingFor(view, target);
  assert.deepEqual([now.model, now.effort, now.revision], ["claude_opus_5_5", "high", 3]);
  // Morrow and new specialists resolve too; an agent no longer on the team has nothing to
  // change (its dialog closes).
  assert.equal(thinkingFor(view, { kind: "morrow" }), view.morrow.thinking);
  assert.equal(thinkingFor(view, { kind: "specialists" }), view.specialistDefault);
  assert.equal(thinkingFor(view, { kind: "agent", id: "agent-gone" }), null);
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
      command({ model: "claude_haiku_5_5", effort: "medium", monthlyCreditLimit: 250 }),
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
  // The new agent is what the confirmed document said: its thinking and its monthly limit.
  const marketing = team.agents.at(-1);
  assert.deepEqual(
    [marketing.thinking.model, marketing.thinking.effort, marketing.credits.limit],
    ["claude_haiku_5_5", "medium", 250],
  );
  const page = (await solo.team.agent(ws, "agent-marketing")).value;
  assert.deepEqual([page.creditsMonth.limit, page.thinking.model], [250, "claude_haiku_5_5"]);
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

test("an unknown thinking change or add leaves a marker of its own, so its dialog may close", async () => {
  const pending = createPending({ storage: new MemoryStorage() });
  for (const kind of ["thinking", "add_agent"]) {
    const sent = command({ kind });
    const outcome = await pending.run(sent, { workspaceId: ws, kind }, async () => ({
      kind: "uncertain",
    }));
    assert.equal(outcome.kind, "uncertain");
    // The dialog closes: its form releases the key, and the marker stays for the shell.
    pending.release(sent.key);
    assert.ok(
      pending.markers().some((m) => m.kind === kind && m.workspaceId === ws),
      kind,
    );
    assert.ok(!pending.liveMarkers().some((m) => m.kind === kind), kind);
    assert.ok(copy.reentry.kinds[kind], kind);
  }
});

test("the Listings agent's choice (the workspace default) is the Owner's, on Team and its page", async () => {
  for (const [scenario, may] of [
    ["ready", true],
    ["team_admin", false],
    ["team_member", false],
  ]) {
    const port = createFixtureAdapter(scenario);
    const listings = (await port.team.overview(ws)).value.agents.find(
      (a) => a.agentId === "agent-listings",
    );
    const models = (await port.models.list(ws)).value;
    // Team's "Change" and the agent page's picker follow the same server decision.
    assert.equal(listings.thinking.canChange, may, scenario);
    assert.equal(models.canRevise, may, scenario);
    const saved = await port.models.reviseDefault(
      ws,
      command({
        model: "claude_haiku_5_5",
        effort: "low",
        maxCreditsPerProduct: models.ceiling,
        expectedRevision: models.revision,
      }),
    );
    assert.equal(saved.kind, may ? "ok" : "denied", scenario);
  }
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
    dailyLimit: 40,
  });
  assert.equal(options.length, 9);
  assert.deepEqual(
    options.filter((o) => !o.fits).map((o) => o.model),
    ["claude_opus_5_5", "claude_opus_5_5", "claude_opus_5_5"],
  );
  assert.ok(options.every((o) => o.unit === "job" && o.limit === 40));
});

test("thinking: the limit a setting must fit is the agent's credits a day, as its page shows", async () => {
  const port = createFixtureAdapter("ready");
  for (const agentId of ["agent-analyst", "agent-inventory", "agent-support"]) {
    const page = (await port.team.agent(ws, agentId)).value;
    assert.equal(page.thinking.source, "own");
    assert.equal(page.thinking.dailyLimit, page.creditsToday.limit, agentId);
    assert.ok(!("jobLimit" in page.thinking));
  }
  // The copy reads the same way: one job's most against what it can use a day.
  assert.match(sunriseCopy.thinking.overJob(42, 40), /up to 42 credits.*40 credits a day/);
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
  // With no agents, the catalogue lists none as added either.
  const offered = (await empty.team.catalogue(ws)).value.entries;
  assert.deepEqual(
    offered.filter((e) => e.addedAs !== null).map((e) => e.name),
    [],
  );
});

test("the catalogue and Team agree: every agent listed as added has a page", async () => {
  for (const scenario of ["ready", "empty", "team_member", "team_admin", "team_solo"]) {
    const port = createFixtureAdapter(scenario);
    const team = (await port.team.overview(ws)).value;
    const added = (await port.team.catalogue(ws)).value.entries.filter((e) => e.addedAs !== null);
    assert.deepEqual(
      added.map((e) => e.addedAs).sort(),
      team.agents.map((a) => a.agentId).sort(),
      scenario,
    );
    for (const e of added)
      assert.equal((await port.team.agent(ws, e.addedAs)).kind, "ok", `${scenario} ${e.name}`);
  }
});

test("plan and credits: the period and projection dates are the server's, not the screen's", async () => {
  const plan = (await createFixtureAdapter("ready").settings.plan(ws)).value;
  assert.deepEqual([plan.periodStart, plan.projectedOn], ["Oct 1", "Oct 31"]);
  // Another month's view reads as that month: nothing in the copy is a fixed date.
  assert.equal(
    sunriseCopy.plan.whereSub("Feb 1", 12, "Today, 9:00 am"),
    "Feb 1 to today, 9:00 am · 12 credits",
  );
  assert.equal(sunriseCopy.plan.projected("Feb 28"), "Left on Feb 28, at this pace");
  const months = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d/;
  const lines = Object.values(sunriseCopy.plan).flatMap((v) =>
    typeof v === "function" ? [v(...sampleArgs(v))] : typeof v === "string" ? [v] : [],
  );
  for (const line of lines) assert.ok(!months.test(line), line);
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
  // The shell's Settings frame is the one menu: the board's order, each page's name.
  assert.deepEqual(
    settingsItems.map((item) => [item.key, item.label]),
    [
      ["usage", "Plan and credits"],
      ["people", "People and roles"],
      ["notifications", "Notifications"],
      ["stores", "Email addresses"],
      ["connections", "Shopify connection"],
      ["governance", "Activity"],
      ["billing", "Model default"],
    ],
  );
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

test("notifications: a save the record moved past meets a real 409; the reread is new", async () => {
  const port = createFixtureAdapter("notifications_conflict");
  const view = (await port.settings.notifications(ws)).value;
  const off = { ...view.email, monday: false };
  const first = await port.settings.reviseNotifications(
    ws,
    command(prefsBody(view, { email: off })),
  );
  assert.deepEqual([first.kind, first.recheck], ["conflict", true]);
  // The reread has moved on: a new revision (so the screen drops its draft) and new choices.
  const now = (await port.settings.notifications(ws)).value;
  assert.equal(now.revision, view.revision + 1);
  assert.notEqual(now.summaryHour, view.summaryHour);
  assert.equal(now.email.monday, true);
  const second = await port.settings.reviseNotifications(
    ws,
    command(prefsBody(now, { email: off })),
  );
  assert.equal(second.kind, "ok");
});

test("activity: who did what, by day; filters are closed; no conversations", async () => {
  const view = (await createFixtureAdapter("ready").settings.activity(ws)).value;
  assert.ok(view.entries.length > 5);
  const categories = new Set(view.entries.map((e) => e.category));
  for (const c of categories) assert.ok([...activityFilters, "work"].includes(c), c);
  assert.ok(!activityFilters.includes("work"));
  for (const e of view.entries) assert.doesNotMatch(e.what + e.detail, /conversation/i);
  // A person's stop reads as Stopped, the word the stop itself uses, never as Paused.
  const stops = view.entries.filter((e) => /^stopped\b/.test(e.what));
  assert.ok(stops.length > 0);
  for (const e of stops) assert.deepEqual([e.badge, e.category], ["stopped", "access"]);
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
const listings = (
  storeId,
  { on = true, stopped = false, mayStop = true, blocked = false } = {},
) => ({
  storeId,
  linked: true,
  blocked,
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
    { storeId: "s1", shopDomain: "s1.example", installationId: "listings-s1", held: false },
  ]);
  assert.equal(state.stopped, 1);
  assert.equal(state.held, 0);
  assert.equal(state.notAllowed, 1);
  assert.deepEqual(stopAllState([]), { targets: [], stopped: 0, held: 0, notAllowed: 0 });
  // A platform or connection stop holds a store: it is paused, not on. This person may still
  // stop it where the server allows (so it stays off once the hold lifts); where the server
  // doesn't, it isn't "work you can't stop" either. A person's own stop is still "stopped".
  const held = stopAllState([
    { connection: store("h1"), listings: listings("h1", { blocked: true }) },
    { connection: store("h2"), listings: listings("h2", { blocked: true, mayStop: false }) },
    { connection: store("h3"), listings: listings("h3", { blocked: true, stopped: true }) },
  ]);
  assert.deepEqual(held, {
    targets: [
      { storeId: "h1", shopDomain: "h1.example", installationId: "listings-h1", held: true },
    ],
    stopped: 1,
    held: 2,
    notAllowed: 0,
  });
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
    held: 0,
    notAllowed: 0,
  });
  // The reason is plain words within the HTTP adapter's bound.
  assert.ok(sunriseCopy.stop.reason.length > 0 && sunriseCopy.stop.reason.length <= 1024);
  // With nothing on (the default sample), there is nothing to stop.
  const ready = createFixtureAdapter("ready");
  const off = (await ready.agents.listingsStatus(ws, connection.storeId)).value;
  assert.deepEqual(stopAllState([{ connection, listings: off }]).targets, []);
});

// Enough of the app's services for a screen rendered to markup (no effect runs there).
const markupServices = {
  navigate() {},
  setDirty() {},
  subscribe: () => () => {},
  version: () => 0,
};
const markup = (element) =>
  renderToStaticMarkup(h(ServicesProvider, { value: markupServices }, element));

test("stop all never reads as all stopped while work this person can't stop is on", () => {
  const status = (state) => markup(h(StopAllStatus, { workspaceId: ws, state, onOpen() {} }));
  // One store stopped; another's Listings is on and the server says this person may not stop it.
  const mixed = status({ targets: [], stopped: 1, held: 0, notAllowed: 1 });
  assert.ok(!/all ai work is stopped|every agent/i.test(mixed), mixed);
  assert.ok(mixed.includes("Listings is stopped on 1 store"), mixed);
  assert.ok(mixed.includes("AI work is still on in 1 store you can’t stop. Ask the Owner."), mixed);
  const all = status({ targets: [], stopped: 2, held: 0, notAllowed: 0 });
  assert.ok(all.includes("Listings is stopped on 2 stores"), all);
  assert.ok(!all.includes("still on"), all);
  // A person's stop wears the Stopped badge; Paused is a platform or connection hold.
  assert.match(all, /<\/svg>Stopped<\/span>/);
  assert.doesNotMatch(all, /Paused/);
  assert.notEqual(sunriseCopy.status.stopped, sunriseCopy.status.paused);
  const on = status({
    targets: [
      { storeId: "s1", shopDomain: "s1.example", installationId: "listings-s1", held: false },
    ],
    stopped: 0,
    held: 0,
    notAllowed: 0,
  });
  assert.ok(on.includes("Listings can be stopped on 1 store"), on);
  // Held by a platform or connection stop: paused, never "on", never "still on".
  const heldTarget = {
    storeId: "h1",
    shopDomain: "h1.example",
    installationId: "l-h1",
    held: true,
  };
  const paused = status({ targets: [heldTarget], stopped: 0, held: 1, notAllowed: 0 });
  assert.ok(paused.includes("AI work is paused · Listings can be stopped on 1 store"), paused);
  assert.ok(paused.includes("Paused in 1 store by a platform or connection stop"), paused);
  assert.ok(!/AI work is on|still on/.test(paused), paused);
  const heldOnly = status({ targets: [], stopped: 0, held: 1, notAllowed: 0 });
  assert.ok(heldOnly.includes("Paused in 1 store"), heldOnly);
  assert.ok(!/AI work is on ·|still on|you can’t stop/.test(heldOnly), heldOnly);
  // After the dialog's stop: every target stopped, and the store it couldn't stop is named.
  const target = { storeId: "s1", shopDomain: "s1.example", installationId: "listings-s1" };
  const stopped = [{ target, phase: { kind: "stopped" } }];
  assert.equal(
    stopOutcomeText(stopped, 1),
    "Listings is stopped on 1 store. AI work is still on in 1 store you can’t stop. Ask the Owner.",
  );
  assert.equal(stopOutcomeText(stopped, 0), "Listings is stopped on 1 store.");
  assert.equal(
    stopOutcomeText([{ target, phase: { kind: "uncertain" } }], 0),
    sunriseCopy.stop.partly,
  );
  // No line of the stop's copy claims that every agent, or all AI work, stopped.
  const lines = Object.values(sunriseCopy.stop).flatMap((v) =>
    typeof v === "function" ? [v(1, 1), v(3, 2)] : Array.isArray(v) ? v : [v],
  );
  for (const line of lines)
    assert.ok(!/all ai work is stopped|every agent/i.test(String(line)), String(line));
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
  // Six figures with a body, plus the labelled Listings; Morrow's tile needs no clip.
  assert.equal(clips.length, 7);
  assert.equal(new Set(clips).size, 7);
  for (const id of clips) {
    assert.match(id, /^sa-[a-z]+-[A-Za-z0-9_-]+$/);
    assert.ok(html.includes(`clip-path="url(#${id})"`), id);
  }
  assert.equal((html.match(/aria-hidden="true"/g) ?? []).length >= characters.length, true);
  assert.match(html, /role="img" aria-label="Listings"/);
  // PR 14's drawings: the Business Analyst is the shell's `analyst`.
  assert.match(html, /data-agent="analyst"/);
  // Below 24 px a tile shows the initial, not a drawing.
  assert.match(html, /class="avatar avatar-agent avatar-initial" data-agent="support"[^>]*>S</);
  assert.match(html, /class="avatar avatar-person"[^>]*aria-hidden="true">MC/);
  assert.match(html, /, online/);
});

// ADR-0032 item 4: internal terms stay out of the interface.
const banned =
  /\b(?:runs?|tokens?|digests?|mandates?|tool calls?|workflows?|triggers?|webhooks?|queues?|retry|retries|scopes?|api|prompts?|sandbox(?:es)?|artifacts?|releases?|install(?:ed|s|ing)?|coordinator|delegat\w*|threads?)\b/i;
// Copy functions take text and counts in turn (text first), so one sampler fits them all.
function sampleArgs(fn) {
  return Array.from({ length: fn.length }, (_, i) => (i % 2 ? 3 : "Sample"));
}
function strings(value, path, out) {
  if (typeof value === "string") out.push([path, value]);
  else if (typeof value === "function") {
    strings(value(...sampleArgs(value)), path + "()", out);
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
