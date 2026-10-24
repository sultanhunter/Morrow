import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { workspaceRoutes } from "../packages/contracts/src/routes.ts";
import {
  generateUiTokens,
  inspectColourLiterals,
  targetFloors,
  tokensJsonPath,
} from "../scripts/generate-ui-tokens.mjs";
import { json, recordingTransport } from "./fixtures/workspace-web.mjs";
// The test runner compiles TSX with the classic runtime (no root tsconfig), so React is a
// global before any component module loads; the apps compile it with their own tsconfig.
globalThis.React = React;
const {
  AgentAvatar,
  AgentPill,
  HorizonPicture,
  SpecialistPill,
  agentNames,
  monogram,
  personInitials,
} = await import("../packages/workspace-ui/src/components/avatars.tsx");
const { SettingsNavigation, inSettings, settingsCurrent, settingsItems } = await import(
  "../packages/workspace-ui/src/components/settings-frame.tsx"
);
const { Navigation } = await import("../packages/workspace-ui/src/components/shell.tsx");
const { ServicesProvider, nextReadSlot } = await import(
  "../packages/workspace-ui/src/services.tsx"
);
const { copy } = await import("../packages/workspace-ui/src/copy.ts");
const { homeDate, homeHeader, homeSummary } = await import(
  "../packages/workspace-ui/src/screens/home.tsx"
);
const { TodayCard } = await import("../packages/workspace-ui/src/screens/home-samples.tsx");
const { ShellRefreshProvider, useConnections, useInbox, useShellRefresh } = await import(
  "../packages/workspace-ui/src/workspace-data.ts"
);
const { destinationTitle, screenTitle } = await import("../apps/workspace-web/src/app.tsx");
const { createClient } = await import("../apps/workspace-web/src/http/client.ts");
const { createHttpPort } = await import("../apps/workspace-web/src/http/api.ts");
const { composed } = await import("../apps/workspace-web/src/http/composed.ts");
const { createFixtureAdapter, fixtureComposedFor } = await import(
  "../apps/workspace-web/src/fixtures/adapter.ts"
);
const { samplesComposedIn, scenarioNames } = await import(
  "../apps/workspace-web/src/fixtures/scenarios.ts"
);
const { fixtureStore, fixtureWorkspace } = await import(
  "../apps/workspace-web/src/fixtures/seed.ts"
);

// T7 PR 14 (ADR-0032): the Sunrise tokens, the agent characters, the sidebar's labels over
// the unchanged route contract, Home's helpers, and the default-off Home preview switch.
// No browser: `npm run ui:check` renders the screens.
const tokens = JSON.parse(readFileSync(tokensJsonPath, "utf8"));
const h = React.createElement;
const render = (element) => renderToStaticMarkup(element);

test("tokens: schema 2 names Sunrise, and its floors are ADR-0032 item 5's", () => {
  assert.equal(tokens.schema_version, 2);
  assert.match(tokens.direction, /Sunrise/);
  assert.deepEqual(targetFloors(), { minimum: 44, phone: 48, phoneBelow: 760 });
  // The board's starting values (ADR-0032 item 2).
  assert.equal(tokens.color.page, "#F4F2ED");
  assert.equal(tokens.color.text, "#25231F");
  assert.equal(tokens.color.link, "#005BD3");
  assert.equal(tokens.color.focus, "#005BD3");
  assert.equal(tokens.color.marigold, "#F2B33D");
  assert.equal(tokens.type.body.split(",")[0], "Inter");
  assert.equal(tokens.type.scale.body.size, 16);
  for (const [name, step] of Object.entries(tokens.type.scale))
    if (name !== "count") assert.ok(step.size >= 14, `${name} is at least 14 px`);
});

test("tokens: never violet or lavender (ADR-0032 item 2; Built for Shopify 4.3.5)", () => {
  const hsl = (hex) => {
    const [r, g, b] = hex
      .slice(1, 7)
      .match(/../g)
      .map((x) => parseInt(x, 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, s: 0, l };
    const s = d / (1 - Math.abs(2 * l - 1));
    const h =
      max === r
        ? 60 * (((g - b) / d) % 6)
        : max === g
          ? 60 * ((b - r) / d + 2)
          : 60 * ((r - g) / d + 4);
    return { h: (h + 360) % 360, s, l };
  };
  for (const [name, value] of Object.entries(tokens.color)) {
    const { h: hue, s } = hsl(value);
    assert.ok(!(hue >= 250 && hue <= 320 && s > 0.15), `${name} ${value} reads as violet`);
  }
});

test("tokens: the generator refuses anything outside its closed shape", () => {
  const clone = () => structuredClone(tokens);
  assert.ok(Object.keys(generateUiTokens(tokens)).length === 2);
  const broken = [
    (t) => (t.schema_version = 1),
    (t) => (t.extra = true),
    (t) => (t.color.page = "red"),
    (t) => (t.color["bad-name"] = "#FFFFFF"),
    (t) => (t.legacy_color_aliases.canvas = "nope"),
    (t) => (t.spacing_px = [4, 8, 12, 16, 20, 22]),
    (t) => (t.shadow.card[0].color = "rgba(0,0,0,.1)"),
    (t) => (t.shadow.card[0].url = "x"),
    (t) => (t.type.body = "Inter; } body { color: red"),
    (t) => (t.type.scale.body.size = 12),
    (t) => (t.target_px.minimum = 24) && (t.target_px.phone = 20),
    (t) => (t.content_width_px.wide = 100),
  ];
  for (const [i, change] of broken.entries()) {
    const t = clone();
    change(t);
    assert.throws(() => generateUiTokens(t), /UI_TOKENS_/, `case ${i}`);
  }
  // The generated stylesheet is the only place a colour literal may live.
  const css = generateUiTokens(tokens)["packages/workspace-ui/src/styles/tokens.css"];
  assert.match(css, /--color-page: #f4f2ed;/);
  assert.match(css, /--color-canvas: var\(--color-page\);/);
  assert.match(css, /--shadow-card: 0 0 0 1px #25231f12, 0 1px 0 0 #25231f1a;/);
  assert.match(css, /--target-minimum: 44px;/);
  assert.equal(inspectColourLiterals("packages/workspace-ui/src/x.css", css).length > 0, true);
});

test("avatars: the seven characters, decorative beside a name and labelled alone", () => {
  for (const agent of [...Object.keys(agentNames), "specialist"]) {
    const plain = render(h(AgentAvatar, { agent, size: 40 }));
    assert.match(plain, new RegExp(`data-agent="${agent}"`));
    assert.match(plain, /aria-hidden="true"/);
    assert.doesNotMatch(plain, /role="img"/);
    // Colours come from tokens through classes: no literal in the drawing.
    assert.deepEqual(inspectColourLiterals("packages/workspace-ui/src/a.tsx", plain), []);
    const named = render(h(AgentAvatar, { agent, size: 40, label: "Listings" }));
    assert.match(named, /role="img" aria-label="Listings"/);
  }
  // Below 24 px the tile shows the initial, not the drawing.
  assert.match(render(h(AgentAvatar, { agent: "listings", size: 20 })), />L<\/span>$/);
  // Every clip path is unique per use and referenced by its own figure.
  const two = render(
    h("div", null, h(AgentAvatar, { agent: "listings" }), h(AgentAvatar, { agent: "listings" })),
  );
  const ids = [...two.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.ok(two.includes(`clip-path="url(#${id})"`), id);
  assert.ok(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id)));
});

test("avatars: the Agent and Specialist pills read as ', agent' and ', specialist, one-time'", () => {
  const agent = render(h(AgentPill, { agent: "support" }));
  assert.match(agent, /<span class="visually-hidden">, <\/span>Agent/);
  assert.match(agent, /data-agent="support"/);
  const specialist = render(h(SpecialistPill));
  assert.match(specialist, /, specialist, one-time/);
  assert.match(specialist, /aria-hidden="true">Specialist · one-time</);
  assert.equal(monogram("Linen & Form"), "L&F");
  assert.equal(monogram("Main"), "M");
  assert.equal(monogram("  "), "");
  assert.equal(personInitials("Maya Chen"), "MC");
  assert.equal(personInitials("Leo"), "L");
});

test("sidebar: the contract's seven destinations under their Sunrise labels, paths unchanged", () => {
  const services = { navigate: () => {} };
  const html = render(
    h(
      ServicesProvider,
      { value: services },
      h(Navigation, { workspaceId: "ws-1", currentRoute: "task", waiting: "6" }),
    ),
  );
  const links = [...html.matchAll(/<a href="([^"]+)"[^>]*class="nav-link"[^>]*>(.*?)<\/a>/g)].map(
    (m) => [m[1], m[2].replace(/<[^>]+>/g, "")],
  );
  // The contract's sidebar order (ADR-0032 item 1: a board doesn't reorder it).
  assert.deepEqual(links, [
    ["/w/ws-1", "Home"],
    ["/w/ws-1/work", "Projects"],
    ["/w/ws-1/inbox", "Inbox6, 6 waiting"],
    ["/w/ws-1/agents", "Team"],
    ["/w/ws-1/assets", "Files"],
    ["/w/ws-1/knowledge", "Shop knowledge"],
    ["/w/ws-1/settings", "Settings"],
  ]);
  const sidebar = JSON.parse(readFileSync("docs/contracts/workspace-routes.json", "utf8")).sidebar;
  const pathOf = (route) =>
    workspaceRoutes.routes
      .find((r) => r.id === route)
      .pattern.replace(":workspaceId", "ws-1")
      .replace(/\/$/, "");
  assert.deepEqual(
    links.map(([href]) => href),
    sidebar.primary.map((p) => pathOf(p.route)),
  );
  // A task's ancestry is Work, so Projects is the current page.
  assert.match(html, /href="\/w\/ws-1\/work" class="nav-link" aria-current="page"/);
  // Morrow is always on the team; nothing else is invented without data.
  assert.match(html, /Morrow<span class="visually-hidden">, agent<\/span>/);
  assert.doesNotMatch(html, /Listings|Maya/);
  // Every primary destination of the route contract has a label, and only those.
  assert.deepEqual(
    Object.keys(copy.destinations).sort(),
    JSON.parse(readFileSync("docs/contracts/workspace-routes.json", "utf8"))
      .sidebar.primary.map((p) => p.id)
      .sort(),
  );
});

test("sidebar: Team rows and pins open the contract's targets, and sample rows say so", async () => {
  const sidebar = JSON.parse(readFileSync("docs/contracts/workspace-routes.json", "utf8")).sidebar;
  assert.deepEqual(
    sidebar.people_and_agents.map((t) => [t.id, t.route, t.params ?? null]),
    [
      ["people", "settings_section", { section: "people" }],
      ["agents", "agent", null],
    ],
  );
  assert.equal(sidebar.pinned_projects.route, "project");
  const footer = Object.fromEntries(sidebar.footer.map((f) => [f.id, f]));
  assert.deepEqual(footer.credit_balance.params, { section: "usage" });
  assert.equal(footer.credit_balance.display_only, true);
  const preview = await createFixtureAdapter("home_preview").samples.home(fixtureWorkspace.id);
  const html = render(
    h(
      ServicesProvider,
      { value: { navigate: () => {} } },
      h(Navigation, { workspaceId: "ws-1", currentRoute: "home", samples: preview.value }),
    ),
  );
  const subLinks = [
    ...html.matchAll(/<a href="([^"]+)"[^>]*class="nav-sublink[^"]*"[^>]*>(.*?)<\/a>/g),
  ].map((m) => [m[1], m[2].replace(/<[^>]+>/g, "")]);
  assert.deepEqual(subLinks, [
    ["/w/ws-1/projects/proj-tote-ai", "Everyday Tote in AI answers, Ends Dec 4, sample data"],
    ["/w/ws-1/projects/proj-autumn", "Autumn collection, Ends Nov 16, sample data"],
    ["/w/ws-1/projects/proj-black-friday", "Black Friday sale, Ends Nov 30, sample data"],
    ["/w/ws-1/work", "Everyday work"],
    // Morrow, the Coordinator, is no installation: its row opens Ask Morrow.
    ["/w/ws-1/ask", "Morrow, agent"],
    ["/w/ws-1/agents/inst-sample-listings", "Listings, agent, sample data"],
    ["/w/ws-1/agents/inst-sample-analyst", "Business Analyst, agent, sample data"],
    ["/w/ws-1/agents/inst-sample-inventory", "Inventory, agent, sample data"],
    ["/w/ws-1/agents/inst-sample-support", "Support, agent, sample data"],
    // (A person's initials are their avatar's, hidden from screen readers.)
    ["/w/ws-1/settings/people", "MCMaya Chen, online, sample data"],
    ["/w/ws-1/settings/people", "LMLeo Martin, away, sample data"],
  ]);
  // One visible tag over each sample group, hidden from screen readers (each link says it).
  assert.equal(
    [...html.matchAll(/<li class="nav-sample" aria-hidden="true">.*?Sample data.*?<\/li>/g)].length,
    2,
  );
  // Without samples there's no pin, no sample tag, and Morrow alone on the Team.
  const plain = render(
    h(
      ServicesProvider,
      { value: { navigate: () => {} } },
      h(Navigation, { workspaceId: "ws-1", currentRoute: "home" }),
    ),
  );
  assert.doesNotMatch(plain, /Sample data|sample data|nav-sublink-project/);
});

test("titles: renamed destinations keep the contract's routes and show the Sunrise names", () => {
  assert.equal(destinationTitle("work"), "Projects");
  assert.equal(destinationTitle("agents"), "Team");
  assert.equal(destinationTitle("assets"), "Files");
  assert.equal(destinationTitle("knowledge"), "Shop knowledge");
  assert.equal(destinationTitle("inbox"), "Inbox");
  assert.equal(destinationTitle("connections"), "Shopify connection");
  assert.equal(
    screenTitle({
      session: "active",
      match: { id: "work", params: { workspaceId: "w" } },
      entryFailed: false,
    }),
    "Projects",
  );
  // The route contract itself is unchanged.
  assert.equal(workspaceRoutes.routes.find((r) => r.id === "work").title, "Work");
  assert.equal(workspaceRoutes.routes.find((r) => r.id === "work").pattern, "/w/:workspaceId/work");
});

test("Home: date line, greeting, urgency order and counts", () => {
  assert.deepEqual(homeHeader(new Date(2026, 9, 23, 10, 20)), {
    date: "Friday, October 23",
    greeting: "Good morning",
  });
  assert.equal(homeHeader(new Date(2026, 9, 23, 13, 0)).greeting, "Good afternoon");
  assert.equal(homeHeader(new Date(2026, 9, 23, 19, 0)).greeting, "Good evening");
  assert.equal(homeDate("2026-10-26T12:00:00.000Z"), "Mon, Oct 26");
  assert.equal(homeDate("2026-10-26T12:00:00.000Z", "plain"), "Oct 26");
  assert.equal(homeDate("soon"), "soon");
  assert.equal(copy.home.review("1"), "Review 1 item");
  assert.equal(copy.home.review("6"), "Review 6 items");
});

test("Home: only a fully answered Inbox read is an all-clear (F1, AC26's first-run Home)", () => {
  // v1 PR 15: Home's header counts the Inbox read's open items (the sidebar's count too).
  const sections = { questions: "ok", approvals: "ok", changes: "ok", connections: "ok" };
  const ok = (items, more = false, over = {}) => ({
    kind: "ok",
    value: { sections: { ...sections, ...over }, items, more },
    replayed: false,
  });
  const question = { kind: "question", id: "q", open: true };
  const failed = { kind: "exception", id: "op", open: false };
  // Nothing waits, and the server said so: Ask Morrow is the primary and the line is clear.
  assert.deepEqual(homeSummary(ok([]), null), { action: "ask", total: "0", open: 0, clear: true });
  assert.deepEqual(homeSummary(ok([question]), null), {
    action: "review",
    total: "1",
    open: 1,
    clear: false,
  });
  // A change that wasn't applied is listed, not counted: still clear.
  assert.deepEqual(homeSummary(ok([failed]), null), {
    action: "ask",
    total: "0",
    open: 0,
    clear: true,
  });
  assert.equal(homeSummary(ok([question], true), null).total, "1+");
  // More waits than the reply carries: never an all-clear beside "0+" (F2), whatever is
  // listed but not counted.
  for (const items of [[], [failed]])
    assert.deepEqual(homeSummary(ok(items, true), null), {
      action: null,
      total: "0+",
      open: 0,
      clear: false,
    });
  // A denied section says nothing about what waits there: no all-clear, no primary.
  assert.deepEqual(homeSummary(ok([], false, { questions: "denied" }), null), {
    action: null,
    total: "0",
    open: 0,
    clear: false,
  });
  // A read that didn't answer says nothing about what waits: no primary, no all-clear.
  for (const failedRead of [
    { kind: "loading" },
    { kind: "denied", message: "", reference: null },
    { kind: "unavailable", offline: true },
    { kind: "unavailable", offline: false },
    { kind: "rate_limited", retryAfterSeconds: 5 },
    { kind: "not_found" },
    { kind: "not_in_build" },
  ])
    assert.deepEqual(
      homeSummary(failedRead, null),
      { action: null, total: "0", open: 0, clear: false },
      failedRead.kind,
    );
  // The preview's sample counts never make a failed read look clear either.
  const samples = { waiting: { review: 3, tasks: 1, alerts: 1 } };
  assert.deepEqual(homeSummary({ kind: "not_found" }, samples), {
    action: "review",
    total: "4",
    open: 0,
    clear: false,
  });
  assert.equal(copy.home.scopeClear("Shop").startsWith("Nothing needs you"), true);
});

test("Home preview: samples.home is a default-off switch that only the fixture answers", async () => {
  // Over HTTP it is never composed and sends nothing.
  assert.equal(composed["samples.home"], false);
  const recorded = recordingTransport(() => json(200, {}));
  const port = createHttpPort({
    client: createClient({ transport: recorded.transport, online: () => true }),
    composed,
    loginBodyVersion: 2,
    navigationSignal: () => undefined,
  });
  assert.deepEqual(await port.samples.home("ws-1"), { kind: "not_in_build" });
  assert.equal(recorded.calls.length, 0);
  // In the fixture, only its own scenario composes it.
  assert.deepEqual(samplesComposedIn, ["home_preview"]);
  for (const scenario of scenarioNames)
    assert.equal(
      fixtureComposedFor(scenario)["samples.home"],
      scenario === "home_preview",
      scenario,
    );
  assert.equal(
    (await createFixtureAdapter("ready").samples.home(fixtureWorkspace.id)).kind,
    "not_in_build",
  );
  const preview = await createFixtureAdapter("home_preview").samples.home(fixtureWorkspace.id);
  assert.equal(preview.kind, "ok");
  assert.deepEqual(
    preview.value.team.agents.map((a) => a.agent),
    ["listings", "analyst", "inventory", "support"],
  );
  assert.equal(
    (await createFixtureAdapter("home_preview").samples.home("ws-other")).kind,
    "not_found",
  );
});

test("Home preview: Today names each agent with its pill (review F4; ADR-0032 item 3)", async () => {
  const samples = (await createFixtureAdapter("home_preview").samples.home(fixtureWorkspace.id))
    .value;
  const html = render(h(TodayCard, { samples }));
  // The avatar is decorative, so the byline says what each one is: ", agent" for an agent,
  // ", specialist, one-time" for a specialist.
  assert.match(
    html,
    /Listings<\/span><span class="agent-pill" data-agent="listings"><span class="visually-hidden">, <\/span>Agent<\/span><\/span> · Product pages/,
  );
  assert.match(
    html,
    /Business Analyst<\/span><span class="agent-pill" data-agent="analyst"><span class="visually-hidden">, <\/span>Agent<\/span><\/span> · Sales and numbers/,
  );
  assert.match(
    html,
    /Sale planner<\/span><span class="agent-pill" data-agent="specialist"><span class="visually-hidden">, specialist, one-time<\/span>/,
  );
  const rows = html.split("<li ").slice(1);
  assert.equal(rows.length, samples.today.length);
  for (const [i, item] of samples.today.entries())
    if (item.agent) assert.match(rows[i], /class="agent-pill"/, item.who);
});

test("reads: a re-read under a refresh mark keeps an ok reply through a failure (review F1)", () => {
  const ok = { key: "k#m1#0", base: "k", value: { kind: "ok", value: 1, replayed: false } };
  const reply = (value, base = "k") => ({ key: `${base}#m2#0`, base, value });
  const unanswered = [
    { kind: "unavailable", offline: false },
    { kind: "unavailable", offline: true },
    { kind: "rate_limited", retryAfterSeconds: 5 },
    { kind: "uncertain" },
  ];
  for (const value of unanswered) {
    assert.equal(nextReadSlot(ok, reply(value), true), ok, value.kind);
    // Without a mark (a page's own read), the reply is shown as before.
    assert.deepEqual(nextReadSlot(ok, reply(value), false), reply(value), value.kind);
  }
  // An answer always replaces the ok reply.
  const answers = [
    { kind: "ok", value: 2, replayed: false },
    { kind: "denied", message: "", reference: null },
    { kind: "not_found" },
    { kind: "unauthenticated" },
  ];
  for (const value of answers)
    assert.deepEqual(nextReadSlot(ok, reply(value), true), reply(value), value.kind);
  // With no ok reply on screen (a Retry after a failure), any reply is shown.
  const failed = { key: "k#m1#0", base: "k", value: unanswered[1] };
  assert.deepEqual(nextReadSlot(failed, reply(unanswered[0]), true), reply(unanswered[0]));
  // Another read's ok reply is never kept for this one.
  const other = { ...ok, key: "j#m1#0", base: "j" };
  assert.deepEqual(nextReadSlot(other, reply(unanswered[0]), true), reply(unanswered[0]));
});

test("shared reads: Home's Retry is the shell's; command pages read once per mount (F1, F2)", () => {
  const never = () => new Promise(() => {});
  const services = {
    subscribe: () => () => {},
    version: () => 7,
    read: never,
    composed: {},
    port: { inbox: { read: never }, connections: { list: never } },
  };
  const bump = () => {};
  const seen = {};
  function Page() {
    seen.inbox = useInbox("ws-1")[1];
    seen.connections = useConnections("ws-1")[1];
    seen.mount = useConnections("ws-1", "mount")[1];
    return null;
  }
  const inShell = h(ShellRefreshProvider, { value: { mark: "home|7|0", bump } }, h(Page));
  render(h(ServicesProvider, { value: services }, inShell));
  // Inside the shell, Retry on Home reads the shell's copy too (the same mark, one request).
  assert.equal(seen.inbox, bump);
  assert.equal(seen.connections, bump);
  // A page that holds a command reads on its own: its Retry is its own.
  assert.equal(typeof seen.mount, "function");
  assert.notEqual(seen.mount, bump);
  // Outside the shell every read has its own Retry.
  render(h(ServicesProvider, { value: services }, h(Page)));
  assert.notEqual(seen.inbox, bump);
  // The shell's mark: the page, the command changes and the Retries.
  let refresh = null;
  function Shell() {
    refresh = useShellRefresh("home{}");
    return null;
  }
  render(h(ServicesProvider, { value: services }, h(Shell)));
  assert.equal(refresh.mark, "home{}|7|0");
  assert.equal(typeof refresh.bump, "function");
  // The pages that hold a command (a store link, a Listings enable, Ask's goal, task and
  // run) never follow the shell: every connections read there is per mount.
  for (const file of ["connections.tsx", "ask.tsx"]) {
    const source = readFileSync(
      new URL(`../packages/workspace-ui/src/screens/${file}`, import.meta.url),
      "utf8",
    );
    const calls = source.match(/useConnections\([^)]*\)/g) ?? [];
    assert.ok(calls.length >= 1, file);
    for (const call of calls) assert.match(call, /, "mount"\)$/, `${file}: ${call}`);
  }
});

test("fixture: the review scenarios fail connections after the enable, and Home's first read", async () => {
  const ws = fixtureWorkspace.id;
  const store = fixtureStore.storeId;
  const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // F1: connections answer until the enable is sent, then fail; the enable's reply is
  // lost, and Check again (the same key) replays it.
  const blip = createFixtureAdapter("listings_enable_reread_failed");
  assert.equal((await blip.connections.list(ws)).kind, "ok");
  const doc = await blip.agents.listingsDocument(ws, store, { key: key(1), body: {} });
  assert.equal(doc.kind, "ok");
  assert.equal((await blip.connections.list(ws)).kind, "ok");
  const enable = {
    key: key(2),
    body: { documentDigest: doc.value.documentDigest, nonce: doc.value.nonce },
  };
  assert.equal((await blip.agents.listingsEnable(ws, store, enable)).kind, "uncertain");
  assert.deepEqual(await blip.connections.list(ws), { kind: "unavailable", offline: false });
  const replay = await blip.agents.listingsEnable(ws, store, enable);
  assert.equal(replay.kind, "ok");
  assert.equal(replay.replayed, true);
  // F2: the first open-questions read is offline; the next one answers.
  const offline = createFixtureAdapter("home_offline_retry");
  assert.deepEqual(await offline.work.listMyOpenQuestions(ws, null), {
    kind: "unavailable",
    offline: true,
  });
  const again = await offline.work.listMyOpenQuestions(ws, null);
  assert.equal(again.kind, "ok");
  assert.ok(again.value.items.length > 0);
});

test("modules: nothing renders at import, so a classic-runtime loader needs no React global", () => {
  // The unit tests load TSX with the classic runtime: an element built at module scope
  // would throw "React is not defined" before any test runs.
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'await import("./packages/workspace-ui/src/index.ts"); await import("./apps/workspace-web/src/app.tsx");',
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
});

test("entry picture: Morrow on the horizon, decorative, colours from tokens only", () => {
  const html = render(h(HorizonPicture));
  assert.match(html, /^<svg class="horizon-picture"[^>]*aria-hidden="true"/);
  assert.match(html, /data-agent="morrow"/);
  assert.doesNotMatch(html, /role="img"|aria-label/);
  assert.deepEqual(inspectColourLiterals("packages/workspace-ui/src/p.tsx", html), []);
  const two = render(
    h(
      "div",
      null,
      h(HorizonPicture, { agent: "listings" }),
      h(HorizonPicture, { agent: "listings" }),
    ),
  );
  const ids = [...two.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, 2);
});

test("settings: one Settings frame lists every page, Activity under Settings and never in the sidebar", () => {
  const services = { navigate: () => {} };
  const html = render(
    h(
      ServicesProvider,
      { value: services },
      h(SettingsNavigation, { workspaceId: "ws-1", current: "connections" }),
    ),
  );
  const links = [
    ...html.matchAll(/<a href="([^"]+)"[^>]*class="settings-link"[^>]*>(.*?)<\/a>/g),
  ].map((m) => [m[1], m[2].replace(/<[^>]+>/g, "")]);
  // The contract's own paths, under the board's names (T7 PR 16 gives each page a screen;
  // the contract has no `email` or `activity` section yet, so they use `stores` and
  // `governance`, and the model default moves to `billing`).
  assert.deepEqual(links, [
    ["/w/ws-1/settings/usage", "Plan and credits"],
    ["/w/ws-1/settings/people", "People and roles"],
    ["/w/ws-1/settings/notifications", "Notifications"],
    ["/w/ws-1/settings/stores", "Email addresses"],
    ["/w/ws-1/connections", "Shopify connection"],
    ["/w/ws-1/settings/governance", "Activity"],
    ["/w/ws-1/settings/billing", "Model default"],
  ]);
  assert.match(html, /href="\/w\/ws-1\/connections" class="settings-link" aria-current="page"/);
  // Stop all AI work ends the card and opens Activity, where the stop and its typed
  // confirmation are; the link itself stops nothing.
  assert.match(
    html,
    /<div class="settings-nav-stop"><a href="\/w\/ws-1\/settings\/governance" class="settings-link settings-link-stop">.*Stop all AI work<\/span><\/a><\/div>/,
  );
  assert.doesNotMatch(html, /is-later/);
  assert.equal(
    workspaceRoutes.routes.some((r) => /activity/.test(r.id)),
    false,
  );
  // The sidebar never lists it.
  const sidebar = render(
    h(
      ServicesProvider,
      { value: services },
      h(Navigation, { workspaceId: "ws-1", currentRoute: "connections" }),
    ),
  );
  assert.doesNotMatch(sidebar, /Activity/);
  assert.match(sidebar, /href="\/w\/ws-1\/settings" class="nav-link" aria-current="page"/);
  // Which item is current, and which routes the frame wraps.
  assert.equal(settingsCurrent("connection", undefined), "connections");
  assert.equal(settingsCurrent("settings_section", "people"), "people");
  assert.equal(settingsCurrent("settings_section", "usage"), "usage");
  assert.equal(settingsCurrent("settings_section", "nope"), null);
  assert.equal(settingsCurrent("settings", undefined), null);
  assert.deepEqual(
    ["settings", "settings_section", "connections", "connection", "home", "inbox"].map(inSettings),
    [true, true, true, true, false, false],
  );
  // Every section item names a value of the contract's closed `section` enum.
  const sections = workspaceRoutes.routes.find((r) => r.id === "settings_section").parameter_enums
    .section;
  for (const item of settingsItems)
    if (item.route === "settings_section") assert.ok(sections.includes(item.key), item.key);
  // Section titles: the board's names; the contract's title stays.
  assert.equal(destinationTitle("settings_section", "people"), "People and roles");
  assert.equal(destinationTitle("settings_section", "usage"), "Plan and credits");
  assert.equal(destinationTitle("settings_section", "governance"), "Activity");
  assert.equal(destinationTitle("settings_section", "billing"), "Model default");
  assert.equal(destinationTitle("settings_section"), "Settings section");
  assert.equal(
    screenTitle({
      session: "active",
      match: { id: "settings_section", params: { workspaceId: "w", section: "notifications" } },
      entryFailed: false,
    }),
    "Notifications",
  );
});
