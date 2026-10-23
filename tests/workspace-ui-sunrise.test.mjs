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
const { ServicesProvider } = await import("../packages/workspace-ui/src/services.tsx");
const { copy } = await import("../packages/workspace-ui/src/copy.ts");
const { byUrgency, homeDate, homeHeader, homeSummary } = await import(
  "../packages/workspace-ui/src/screens/home.tsx"
);
const { waitingCount } = await import("../packages/workspace-ui/src/workspace-data.ts");
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
const { fixtureWorkspace } = await import("../apps/workspace-web/src/fixtures/seed.ts");

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
  assert.deepEqual(links, [
    ["/w/ws-1", "Home"],
    ["/w/ws-1/inbox", "Inbox6, 6 waiting"],
    ["/w/ws-1/work", "Projects"],
    ["/w/ws-1/agents", "Team"],
    ["/w/ws-1/knowledge", "Shop knowledge"],
    ["/w/ws-1/assets", "Files"],
    ["/w/ws-1/settings", "Settings"],
  ]);
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
  const q = (id, expiresAt) => ({ id, expiresAt });
  assert.deepEqual(
    byUrgency([q("a", null), q("b", "2026-10-30T00:00:00Z"), q("c", "2026-10-24T00:00:00Z")]).map(
      (x) => x.id,
    ),
    ["c", "b", "a"],
  );
  assert.equal(waitingCount({ items: [1, 2], next: null }), "2");
  assert.equal(waitingCount({ items: [1], next: "cursor" }), "50+");
  assert.equal(copy.home.review("1"), "Review 1 item");
  assert.equal(copy.home.review("6"), "Review 6 items");
});

test("Home: only an answered open-questions read is an all-clear (F1, AC26's first-run Home)", () => {
  const ok = (items, next = null) => ({ kind: "ok", value: { items, next }, replayed: false });
  // Nothing waits, and the server said so: Ask Morrow is the primary and the line is clear.
  assert.deepEqual(homeSummary(ok([]), null), { action: "ask", total: "0", open: 0, clear: true });
  assert.deepEqual(homeSummary(ok([{ id: "q" }]), null), {
    action: "review",
    total: "1",
    open: 1,
    clear: false,
  });
  assert.equal(homeSummary(ok([{ id: "q" }], "cursor"), null).total, "50+");
  // A read that didn't answer says nothing about what waits: no primary, no all-clear.
  for (const failed of [
    { kind: "loading" },
    { kind: "denied", message: "", reference: null },
    { kind: "unavailable", offline: true },
    { kind: "unavailable", offline: false },
    { kind: "rate_limited", retryAfterSeconds: 5 },
    { kind: "not_found" },
    { kind: "not_in_build" },
  ])
    assert.deepEqual(
      homeSummary(failed, null),
      { action: null, total: "0", open: 0, clear: false },
      failed.kind,
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
  assert.deepEqual(preview.value.team.agents, [
    "morrow",
    "listings",
    "analyst",
    "inventory",
    "support",
  ]);
  assert.equal(
    (await createFixtureAdapter("home_preview").samples.home("ws-other")).kind,
    "not_found",
  );
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

test("settings: Activity sits under Settings as a placeholder, never in the sidebar", () => {
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
  // The contract's own paths, under the board's names.
  assert.deepEqual(links, [
    ["/w/ws-1/settings/billing", "Plan and credits"],
    ["/w/ws-1/settings/people", "People and roles"],
    ["/w/ws-1/settings/notifications", "Notifications"],
    ["/w/ws-1/settings/governance", "Model default"],
    ["/w/ws-1/connections", "Shopify connection"],
  ]);
  assert.match(html, /href="\/w\/ws-1\/connections" class="settings-link" aria-current="page"/);
  // Activity is listed, says it isn't built, and isn't a link until it has a route.
  assert.match(
    html,
    /<span class="settings-link is-later">.*Activity<span class="visually-hidden">, not in this build yet<\/span>/,
  );
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
  assert.equal(settingsCurrent("settings_section", "usage"), null);
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
  assert.equal(destinationTitle("settings_section", "billing"), "Plan and credits");
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
