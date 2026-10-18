// P14.T01a §4.12: the bounded accessibility, keyboard and contrast matrix in Chromium.
//   node scripts/ui-checks.mjs fixture   (`npm run ui:check`: the fixture build under
//                                          `vite preview` with the exact _headers CSP)
//   node scripts/ui-checks.mjs edge      (`npm run ui:edge`: the production dist under
//                                          the unbound dev pair)
// Optional: --only=<a>,<b> runs the cases whose group/name contains any of them.
// Each state case checks axe (WCAG 2.0/2.1 A and AA, 2.2 AA, plus the ARIA-in-HTML
// `aria-allowed-role` rule) with zero violations, one visible provisional note, non-text
// contrast of control borders and focus indicators, reflow, 24 px targets, reduced
// motion, CSP and console errors; an entry screen's title matches its heading. Keyboard
// walks run at 1440 and 390. Tracing, HAR and video stay off; screenshots exist only for
// failed fixture cases. Reports are verdict-only JSON under ui/ in the artifacts directory.
import { createServer } from "node:net";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { artifactPath, repositoryRoot, writeArtifact } from "./artifacts.mjs";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const axeTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
// Tagged best-practice in axe, so the WCAG tags alone skip it: a role an element may not
// take (ARIA in HTML), such as `dialog` on <aside>.
const axeRules = { "aria-allowed-role": { enabled: true } };
const allWidths = [1440, 768, 390, 320];
const heights = { 1440: 900, 768: 1024, 390: 844, 320: 640 };
const ws = "ws-linen";
const provisional = "Provisional workspace · design under review";

/** The `/*` block of apps/workspace-web/public/_headers, as served by Static Assets. */
export function staticHeaders() {
  const text = readFileSync(resolve(repositoryRoot, "apps/workspace-web/public/_headers"), "utf8");
  const headers = {};
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line) && !line.startsWith("#")) inBlock = line.trim() === "/*";
    else if (inBlock && /^\s+\S/.test(line)) {
      const index = line.indexOf(":");
      headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  if (!headers["Content-Security-Policy"]) throw Error("UI_CHECK_HEADERS_MISSING");
  return headers;
}

const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

// ---- in-page measurements (run through CDP evaluation, which the page CSP does not govern)
const pageChecks = () => {
  const parse = (value) => {
    let m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value);
    if (m)
      return [
        Number(m[1]) / 255,
        Number(m[2]) / 255,
        Number(m[3]) / 255,
        m[4] === undefined ? 1 : Number(m[4]),
      ];
    m = /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/.exec(value);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    return null;
  };
  const over = (top, bottom) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
  };
  const backgroundBehind = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color[3] > 0) {
        layers.push(color);
        if (color[3] >= 1) break;
      }
    }
    let result = [1, 1, 1, 1];
    for (const layer of layers.reverse()) result = over(layer, result);
    return result;
  };
  const luminance = ([r, g, b]) =>
    [r, g, b]
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && !el.closest("[inert]")
    );
  };
  window.__morrowUi = {
    focusIndicator() {
      const el = document.activeElement;
      if (!el || el === document.body) return { ok: false, reason: "no_focus" };
      const style = getComputedStyle(el);
      const width = parseFloat(style.outlineWidth);
      const color = parse(style.outlineColor);
      if (style.outlineStyle === "none" || !(width >= 2) || !color)
        return { ok: false, reason: "no_outline", tag: el.tagName };
      const ratio = contrast(
        over(color, backgroundBehind(el.parentElement ?? el)),
        backgroundBehind(el.parentElement ?? el),
      );
      return {
        ok: ratio >= 3,
        reason: ratio >= 3 ? null : "outline_contrast",
        ratio,
        tag: el.tagName,
      };
    },
    measure() {
      const failures = [];
      // Shown on screen, even when a modal drawer makes it inert behind the backdrop.
      const shown = (el) =>
        el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== "hidden";
      const notes = [...document.querySelectorAll('[role="note"]')].filter(shown);
      if (notes.length !== 1 || notes[0].textContent.trim() !== window.__provisional)
        failures.push("provisional_note:" + notes.length);
      if (document.documentElement.scrollWidth > window.innerWidth) failures.push("reflow");
      const targets = [
        ...document.querySelectorAll(
          'a[href], button, input, select, textarea, [role="tab"], [role="menuitemradio"], [tabindex]:not([tabindex="-1"])',
        ),
      ].filter(visible);
      for (const el of targets) {
        const rect = el.getBoundingClientRect();
        const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
        if (!inline && (rect.width < 24 || rect.height < 24))
          failures.push(`target_size:${el.tagName.toLowerCase()}`);
        const style = getComputedStyle(el);
        const border = parse(style.borderTopColor);
        const bordered =
          parseFloat(style.borderTopWidth) > 0 &&
          style.borderTopStyle !== "none" &&
          border &&
          border[3] > 0;
        if (
          bordered &&
          ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName) &&
          !el.disabled
        ) {
          const own = parse(style.backgroundColor);
          const behind = backgroundBehind(el.parentElement ?? el);
          const edge = over(border, behind);
          // The boundary is identifiable if the border, or the control's own fill, contrasts.
          const fill = own && own[3] > 0 ? over(own, behind) : null;
          if (contrast(edge, behind) < 3 && !(fill && contrast(fill, behind) >= 3))
            failures.push(`control_border_contrast:${el.tagName.toLowerCase()}`);
        }
      }
      for (const el of document.querySelectorAll("body *")) {
        const style = getComputedStyle(el);
        const durations = [style.transitionDuration, style.animationDuration].join(",").split(",");
        if (durations.some((d) => parseFloat(d) > 0)) {
          failures.push("motion_not_reduced");
          break;
        }
      }
      return [...new Set(failures)];
    },
  };
};

async function axeViolations(page) {
  const defined = await page.evaluate("typeof window.axe");
  if (defined !== "object") await page.evaluate(axeSource);
  const result = await page.evaluate(
    ({ tags, rules }) =>
      window.axe
        .run(document, {
          runOnly: { type: "tag", values: tags },
          rules,
          resultTypes: ["violations"],
        })
        .then((r) => r.violations.map((v) => `${v.id}:${v.nodes.length}`)),
    { tags: axeTags, rules: axeRules },
  );
  return result;
}

async function settle(page) {
  await page.waitForSelector("#main", { state: "attached", timeout: 15000 });
  await page
    .waitForFunction(() => !document.querySelector(".state-loading"), null, { timeout: 8000 })
    .catch(() => {});
}

async function openDrawerIfNarrow(page) {
  const menu = page.getByRole("button", { name: "Open navigation" });
  if (await menu.isVisible()) await menu.click();
}
async function signOut(page) {
  await openDrawerIfNarrow(page);
  await page.getByRole("button", { name: "Sign out" }).click();
}
const morrowKeys = (page) =>
  page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("morrow.")));
const intendedRoute = (page) => page.evaluate(() => sessionStorage.getItem("morrow.intended.v1"));
// One text-free marker, as an earlier uncertain command would have left (§4.9).
const plantMarker = (page) =>
  page.evaluate((workspaceId) => {
    const marker = [{ workspaceId, kind: "goal", at: 1 }];
    sessionStorage.setItem("morrow.unconfirmed.v1", JSON.stringify(marker));
  }, ws);

// ---- the matrix
const fixtureCase = (
  group,
  name,
  path,
  { scenario = null, widths = allWidths, setup = null } = {},
) => ({
  group,
  name,
  path,
  scenario,
  widths,
  setup,
});
const fillGoal = async (page) => {
  await page.getByRole("button", { name: "Create goal" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Objective").fill("Plan the winter range");
  await dialog.getByLabel("Criterion 1").fill("Range agreed");
  await dialog.getByRole("button", { name: "Create goal" }).click();
};
export const fixtureCases = [
  fixtureCase("entry", "sign_in", `/w/${ws}`, { scenario: "session_expired" }),
  fixtureCase("entry", "signed_out", `/w/${ws}`, {
    setup: async (page) => {
      await signOut(page);
      await page.getByRole("heading", { name: "You're signed out" }).waitFor();
    },
  }),
  fixtureCase("entry", "not_found", "/nope"),
  fixtureCase("entry", "workspace_unavailable", `/w/${ws}`, { scenario: "workspace_unavailable" }),
  // PR-1 rule: the 401 after a restore offers Sign in (§4.6).
  fixtureCase("entry", "workspace_unavailable_restored", `/w/${ws}`, {
    scenario: "restore_unavailable",
    setup: async (page) => {
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: "This workspace isn't available to you" }).waitFor();
    },
  }),
  fixtureCase("entry", "workspace_load_failed", `/w/${ws}`, { scenario: "bootstrap_unavailable" }),
  fixtureCase("entry", "sign_out_incomplete", `/w/${ws}`, {
    scenario: "sign_out_unavailable",
    setup: async (page, width) => {
      await signOut(page);
      await page.getByText("Sign-out didn't complete. You're still signed in.").waitFor();
      if (width < 760) await page.getByRole("button", { name: "Close navigation" }).click();
    },
  }),
  fixtureCase("entry", "sign_out_unconfirmed", `/w/${ws}`, {
    scenario: "sign_out_unknown",
    setup: async (page) => {
      await signOut(page);
      await page
        .getByRole("heading", { name: "We couldn't confirm you were signed out" })
        .waitFor();
    },
  }),
  fixtureCase("entry", "unavailable_destination", `/w/${ws}/agents`),
  fixtureCase("account", "form", "/", { scenario: "account_form" }),
  fixtureCase("account", "chooser", "/", { scenario: "account_chooser" }),
  fixtureCase("account", "invite", "/", { scenario: "account_invite" }),
  fixtureCase("home", "ready", `/w/${ws}`),
  fixtureCase("home", "partial_denied", `/w/${ws}`, { scenario: "home_partial_denied" }),
  fixtureCase("task", "brief", `/w/${ws}/work/task-titles`),
  fixtureCase("task", "questions", `/w/${ws}/work/task-titles`, {
    setup: (page) => page.getByRole("tab", { name: "Questions" }).click(),
  }),
  ...["ready", "empty", "denied", "offline", "reentry"].map((scenario) =>
    fixtureCase("work", scenario, `/w/${ws}/work`, { scenario }),
  ),
  fixtureCase("work", "conflict", `/w/${ws}/work`, { scenario: "conflict", setup: fillGoal }),
  fixtureCase("work", "uncertain", `/w/${ws}/work`, { scenario: "uncertain", setup: fillGoal }),
  fixtureCase("inbox", "inbox", `/w/${ws}/inbox`),
  fixtureCase("inbox", "question_open", `/w/${ws}/inbox/questions/q-source`),
  fixtureCase("inbox", "question_answered", `/w/${ws}/inbox/questions/q-titles`),
  fixtureCase("overlay", "drawer", `/w/${ws}`, {
    widths: [390, 320],
    setup: (page) => page.getByRole("button", { name: "Open navigation" }).click(),
  }),
  fixtureCase("overlay", "create_goal_dialog", `/w/${ws}/work`, {
    widths: [1440, 390],
    setup: (page) => page.getByRole("button", { name: "Create goal" }).first().click(),
  }),
  fixtureCase("overlay", "leave_dialog", `/w/${ws}/inbox/questions/q-source`, {
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByLabel("Your answer").fill("Draft text");
      await page.getByRole("link", { name: "Back to Inbox" }).click();
      await page.getByRole("dialog", { name: "Leave this page?" }).waitFor();
    },
  }),
  fixtureCase("overlay", "switcher", `/w/${ws}`, {
    widths: [1440, 768],
    setup: (page) => page.getByRole("button", { name: /Switch workspace/ }).click(),
  }),
];
export const edgeCases = [
  fixtureCase("edge", "landing", "/"),
  fixtureCase("edge", "sign_in", "/w/ws-edge-lab"),
  fixtureCase("edge", "not_found", "/nope"),
];

// ---- keyboard walks (1440 and 390)
const active = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName ?? null,
      role: el?.getAttribute("role") ?? null,
      text: (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim().slice(0, 60),
      id: el?.id ?? null,
      className: typeof el?.className === "string" ? el.className : "",
      inDrawer: !!el?.closest(".sidebar.is-open"),
      inDialog: !!el?.closest("dialog[open]"),
    };
  });
async function tabTo(page, predicate, limit = 60) {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const now = await active(page);
    const indicator = await page.evaluate(() => window.__morrowUi.focusIndicator());
    if (!indicator.ok)
      throw Error("focus_indicator:" + indicator.reason + ":" + (indicator.tag ?? ""));
    if (predicate(now)) return now;
  }
  throw Error("not_reached");
}
const expect = (condition, code) => {
  if (!condition) throw Error(code);
};
export const keyboardWalks = [
  {
    name: "skip_link_first",
    path: `/w/${ws}`,
    run: async (page) => {
      const first = await tabTo(page, () => true, 1);
      expect(first.className.includes("skip-link"), "skip_link_not_first");
      await page.keyboard.press("Enter");
      expect((await active(page)).id === "main", "skip_link_target");
    },
  },
  {
    name: "tab_order_visible_focus",
    path: `/w/${ws}`,
    run: async (page) => {
      // From the skip link to the end of the document: every stop shows its focus.
      const seen = new Set();
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press("Tab");
        const indicator = await page.evaluate(() => window.__morrowUi.focusIndicator());
        if (indicator.reason === "no_focus") break;
        expect(indicator.ok, "focus_indicator:" + indicator.reason);
        const now = await active(page);
        const key = `${now.tag}|${now.text}|${now.id}`;
        if (seen.has(key)) break;
        seen.add(key);
      }
      expect(seen.size >= 5, "too_few_stops");
    },
  },
  {
    name: "navigation",
    path: `/w/${ws}`,
    run: async (page, width) => {
      if (width < 760) {
        await tabTo(page, (a) => a.text === "Open navigation");
        await page.keyboard.press("Enter");
        expect((await active(page)).inDrawer, "drawer_focus");
        expect(
          await page.evaluate(() => document.querySelector(".main-column")?.hasAttribute("inert")),
          "background_not_inert",
        );
        for (let i = 0; i < 16; i++) {
          await page.keyboard.press("Tab");
          expect((await active(page)).inDrawer, "focus_left_drawer");
        }
        await page.keyboard.press("Escape");
        const back = await active(page);
        expect(back.text === "Open navigation", "escape_focus_restore");
        await page.keyboard.press("Enter");
      }
      await tabTo(page, (a) => a.tag === "A" && a.text === "Work");
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/w/${ws}/work`);
      if (width < 760) {
        await page.getByRole("button", { name: "Open navigation" }).click();
      }
      const current = await page
        .locator('nav[aria-label="Main"] [aria-current="page"]')
        .textContent();
      expect(current.trim() === "Work", "aria_current");
    },
  },
  {
    name: "tabs",
    path: `/w/${ws}/work/task-titles`,
    run: async (page) => {
      await tabTo(page, (a) => a.role === "tab");
      await page.keyboard.press("ArrowRight");
      expect((await active(page)).text === "Questions", "arrow_right");
      expect(
        (await page.getByRole("tab", { name: "Questions" }).getAttribute("aria-selected")) ===
          "true",
        "selected",
      );
      await page.keyboard.press("Home");
      expect((await active(page)).text === "Brief", "home_key");
      await page.keyboard.press("End");
      expect((await active(page)).text === "Questions", "end_key");
      await page.keyboard.press("ArrowRight");
      expect((await active(page)).text === "Brief", "wrap");
    },
  },
  {
    name: "switcher_menu",
    path: `/w/${ws}`,
    run: async (page, width) => {
      if (width < 760) {
        await page.getByRole("button", { name: "Open navigation" }).click();
        await page.keyboard.press("Tab");
      }
      await tabTo(page, (a) => a.text.startsWith("Switch workspace"));
      await page.keyboard.press("ArrowDown");
      expect((await active(page)).role === "menuitemradio", "menu_first_item");
      await page.keyboard.press("End");
      expect((await active(page)).role === "menuitemradio", "menu_end");
      await page.keyboard.press("Escape");
      expect((await active(page)).text.startsWith("Switch workspace"), "menu_escape_restore");
      expect(
        (await page.getByRole("menu", { includeHidden: true }).isVisible()) === false,
        "menu_closed",
      );
    },
  },
  {
    name: "create_goal_dialog",
    path: `/w/${ws}/work`,
    run: async (page) => {
      await tabTo(page, (a) => a.text === "Create goal");
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor();
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press("Tab");
        expect((await active(page)).inDialog, "focus_left_dialog");
      }
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      expect((await active(page)).text === "Create goal", "dialog_focus_restore");
    },
  },
  {
    name: "leave_dialog",
    path: `/w/${ws}/inbox/questions/q-source`,
    run: async (page) => {
      await tabTo(page, (a) => a.tag === "TEXTAREA");
      await page.keyboard.type("Unsent words");
      await page.getByRole("link", { name: "Back to Inbox" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog", { name: "Leave this page?" }).waitFor();
      expect((await active(page)).text === "Stay", "stay_focused");
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      expect((await page.getByLabel("Your answer").inputValue()) === "Unsent words", "text_kept");
      expect(page.url().endsWith("/inbox/questions/q-source"), "stayed");
      await page.getByRole("link", { name: "Back to Inbox" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog", { name: "Leave this page?" }).waitFor();
      await page.keyboard.press("Tab");
      expect((await active(page)).text === "Leave", "leave_reachable");
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/w/${ws}/inbox`);
    },
  },
  {
    name: "answer_question",
    path: `/w/${ws}/inbox/questions/q-source`,
    run: async (page) => {
      await tabTo(page, (a) => a.tag === "TEXTAREA");
      await page.keyboard.type("Cite the supplier certificate.");
      await tabTo(page, (a) => a.text === "Send answer");
      await page.keyboard.press("Enter");
      await page.getByText("Answer sent.").waitFor();
      await page.getByText("Cite the supplier certificate.").waitFor();
    },
  },
  {
    name: "sign_in",
    path: `/w/${ws}`,
    scenario: "session_expired",
    run: async (page) => {
      await tabTo(page, (a) => a.text === "Sign in");
      await page.keyboard.press("Enter");
      // The fixture sign-in returns to `/`, which restores the stored intended route.
      await page.waitForURL(`**/w/${ws}`, { timeout: 15000 });
      await page.getByRole("heading", { name: "Linen & Form" }).waitFor();
    },
  },
  {
    name: "account_form",
    path: "/",
    scenario: "account_form",
    run: async (page) => {
      await tabTo(page, (a) => a.tag === "INPUT");
      await page.keyboard.type("Linen and Form Ltd");
      await page.keyboard.press("Tab");
      const second = await active(page);
      expect(second.tag === "INPUT", "second_field");
      await page.keyboard.type("Main");
      await tabTo(page, (a) => a.text === "Create organization");
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/w/${ws}`);
    },
  },
  {
    name: "work_disclosure",
    path: `/w/${ws}/work`,
    run: async (page) => {
      await tabTo(page, (a) => a.text.endsWith("Show tasks"));
      await page.keyboard.press("Enter");
      expect((await active(page)).text.endsWith("Hide tasks"), "expanded");
      await tabTo(
        page,
        (a) => a.tag === "A" && a.text.length > 0 && !["Work", "Home", "Inbox"].includes(a.text),
      );
    },
  },
  {
    // From WorkspaceUnavailable, then from SignedOut: "Go to your workspaces" is a full
    // document load of `/` (nothing private stays in memory), whose account landing opens
    // the fixture's only workspace (§4.6, §4.10).
    name: "account_link",
    path: `/w/${ws}`,
    scenario: "workspace_unavailable",
    run: async (page) => {
      await page.getByRole("heading", { name: "This workspace isn't available to you" }).waitFor();
      for (const from of ["workspace_unavailable", "signed_out"]) {
        if (from === "signed_out") {
          await signOut(page);
          await page.getByRole("heading", { name: "You're signed out" }).waitFor();
        }
        await page.evaluate(() => (window.__sameDocument = true));
        const loaded = page.waitForEvent("load");
        await tabTo(page, (a) => a.tag === "A" && a.text === "Go to your workspaces");
        await page.keyboard.press("Enter");
        await loaded;
        await page.getByRole("heading", { name: "Linen & Form" }).waitFor();
        expect(await page.evaluate(() => window.__sameDocument !== true), "document_load:" + from);
      }
    },
  },
  {
    // PR-1 composition (no probe): the 401 stores the task path; sign-in restores it once;
    // the 401 after the restore shows WorkspaceUnavailable with Sign in and drops the path;
    // a second sign-in lands on `/` with no restore, so there is no loop (AC04, AC06).
    name: "restore_unavailable",
    path: `/w/${ws}/work/task-titles`,
    scenario: "restore_unavailable",
    run: async (page) => {
      await page.getByRole("heading", { name: "Sign in to continue" }).waitFor();
      expect((await intendedRoute(page)) === `/w/${ws}/work/task-titles`, "intended_stored");
      let loaded = page.waitForEvent("load");
      await tabTo(page, (a) => a.text === "Sign in");
      await page.keyboard.press("Enter");
      await loaded;
      await page.getByRole("heading", { name: "This workspace isn't available to you" }).waitFor();
      expect(new URL(page.url()).pathname === `/w/${ws}/work/task-titles`, "restored");
      expect((await intendedRoute(page)) === null, "intended_dropped");
      expect(
        (await page.title()) === "This workspace isn't available to you · Morrow",
        "unavailable_title",
      );
      loaded = page.waitForEvent("load");
      await tabTo(page, (a) => a.text === "Sign in");
      await page.keyboard.press("Enter");
      await loaded;
      await page.getByRole("heading", { name: "Sign in to Morrow" }).waitFor();
      expect(new URL(page.url()).pathname === "/", "landed_at_root");
      expect((await intendedRoute(page)) === null, "no_loop");
    },
  },
  {
    // A bootstrap 503 shows Retry, and Retry enters the workspace (AC06).
    name: "bootstrap_retry",
    path: `/w/${ws}`,
    scenario: "bootstrap_unavailable",
    run: async (page) => {
      await page.getByRole("heading", { name: "This workspace couldn't load" }).waitFor();
      await tabTo(page, (a) => a.text === "Retry");
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Linen & Form" }).waitFor();
    },
  },
  {
    // AC07: a 503 `logout_unavailable` keeps the session, storage and workspace, with Try
    // again; a 503 `logout_outcome_unknown` clears private DOM and storage at once, and
    // Try again confirms. Each Try again that gets 200 ends in SignedOut.
    name: "sign_out_retry",
    path: `/w/${ws}`,
    scenario: "sign_out_unavailable",
    run: async (page, width) => {
      await plantMarker(page);
      await signOut(page);
      await page.getByText("Sign-out didn't complete. You're still signed in.").waitFor();
      if (width < 760) await page.getByRole("button", { name: "Close navigation" }).click();
      expect(await page.getByRole("heading", { name: "Linen & Form" }).isVisible(), "kept_dom");
      expect((await morrowKeys(page)).length === 1, "kept_storage");
      await tabTo(page, (a) => a.text === "Try again");
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "You're signed out" }).waitFor();
      expect((await morrowKeys(page)).length === 0, "cleared_storage");

      await page.goto(new URL(`/w/${ws}?scenario=sign_out_unknown`, page.url()).href);
      await settle(page);
      await plantMarker(page);
      await signOut(page);
      await page
        .getByRole("heading", { name: "We couldn't confirm you were signed out" })
        .waitFor();
      expect((await morrowKeys(page)).length === 0, "unknown_cleared_storage");
      expect((await page.locator(".sidebar, .workspace-main").count()) === 0, "unknown_dom");
      await tabTo(page, (a) => a.text === "Try again");
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "You're signed out" }).waitFor();
    },
  },
  {
    // AC12: a 401 that arrives while "Leave this page?" is open ends the session view;
    // the dialog closes and no beforeunload handler stays registered (§4.6, §4.9).
    name: "expire_during_leave",
    path: `/w/${ws}/inbox/questions/q-source`,
    scenario: "expire_during_leave",
    run: async (page) => {
      await tabTo(page, (a) => a.tag === "TEXTAREA");
      await page.keyboard.type("Unsent words");
      await tabTo(page, (a) => a.text === "Send answer");
      await page.keyboard.press("Enter");
      await page.getByRole("link", { name: "Back to Inbox" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog", { name: "Leave this page?" }).waitFor();
      expect((await page.evaluate(() => window.__beforeunload.size)) === 1, "guard_registered");
      await page.getByRole("heading", { name: "Sign in to continue" }).waitFor({ timeout: 15000 });
      expect((await page.getByRole("dialog").count()) === 0, "dialog_closed");
      expect((await page.evaluate(() => window.__beforeunload.size)) === 0, "guard_released");
      expect(
        (await intendedRoute(page)) === `/w/${ws}/inbox/questions/q-source`,
        "intended_stored",
      );
    },
  },
];

async function runCase(browser, origin, item, width, { fixture, failures: allFailures }) {
  const context = await browser.newContext({
    viewport: { width, height: heights[width] },
    reducedMotion: "reduce",
    colorScheme: "light",
    serviceWorkers: "block",
  });
  await context.addInitScript(
    ({ note }) => {
      window.__csp = [];
      window.__provisional = note;
      document.addEventListener("securitypolicyviolation", (event) =>
        window.__csp.push(event.violatedDirective),
      );
      // The beforeunload handlers currently registered (the leave guard, AC12).
      const registered = new Set();
      window.__beforeunload = registered;
      const add = window.addEventListener;
      const remove = window.removeEventListener;
      window.addEventListener = function (type, listener, options) {
        if (type === "beforeunload") registered.add(listener);
        return add.call(this, type, listener, options);
      };
      window.removeEventListener = function (type, listener, options) {
        if (type === "beforeunload") registered.delete(listener);
        return remove.call(this, type, listener, options);
      };
    },
    { note: provisional },
  );
  // Measurement helpers load with every document, through CDP (not page script).
  await context.addInitScript({ content: `(${pageChecks.toString()})()` });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // A 401 or 503 reply to a request is protocol, not an application error.
    if (
      /^Failed to load resource: the server responded with a status of (401|503)/.test(
        message.text(),
      )
    )
      return;
    errors.push("console_error");
  });
  page.on("pageerror", () => errors.push("page_error"));
  const failures = [];
  try {
    const query = item.scenario ? `?scenario=${item.scenario}` : "";
    await page.goto(origin + item.path + query, { waitUntil: "load" });
    await settle(page);
    if (item.setup) await item.setup(page, width);
    await page.waitForTimeout(50);
    if (item.run) await item.run(page, width);
    else {
      failures.push(...(await page.evaluate(() => window.__morrowUi.measure())));
      failures.push(...(await axeViolations(page)).map((v) => "axe:" + v));
      // A short focus walk: every reachable stop shows a 2 px, 3:1 indicator.
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        const indicator = await page.evaluate(() => window.__morrowUi.focusIndicator());
        if (!indicator.ok && indicator.reason !== "no_focus")
          failures.push("focus_indicator:" + indicator.reason);
      }
      const fixtureBanner = await page.locator(".fixture-controls").count();
      if (fixture !== fixtureBanner > 0) failures.push("fixture_banner:" + fixtureBanner);
      // WCAG 2.4.2: an entry screen's title is its own heading.
      if (item.group === "entry") {
        const titled = await page.evaluate(() => {
          const heading = document.querySelector(".entry-card h1");
          return !heading || document.title === `${heading.textContent.trim()} · Morrow`;
        });
        if (!titled) failures.push("title_mismatch");
      }
    }
    const csp = await page.evaluate(() => window.__csp.length);
    if (csp) failures.push("csp_violation:" + csp);
  } catch (error) {
    failures.push(
      "error:" +
        String(error?.message ?? error)
          .split("\n")[0]
          .slice(0, 120),
    );
  }
  failures.push(...errors);
  const unique = [...new Set(failures)];
  if (unique.length && fixture) {
    const dir = artifactPath("ui/screenshots");
    mkdirSync(dir, { recursive: true });
    await page
      .screenshot({ path: join(dir, `${item.group}-${item.name}-${width}.png`), fullPage: true })
      .catch(() => {});
  }
  await context.close();
  allFailures.push(...unique.map((f) => `${item.group}/${item.name}@${width}:${f}`));
  return {
    group: item.group,
    name: item.name,
    width,
    passed: unique.length === 0,
    failures: unique,
  };
}

async function main() {
  const mode = process.argv[2];
  if (!["fixture", "edge"].includes(mode)) throw Error("UI_CHECK_USAGE: fixture | edge");
  const only =
    process.argv
      .find((a) => a.startsWith("--only="))
      ?.slice(7)
      .split(",") ?? null;
  const selected = (key) => only === null || only.some((part) => key.includes(part));
  const matches = (item) => selected(`${item.group}/${item.name}`);
  let server = null;
  let origin;
  if (mode === "fixture") {
    const { preview } = await import("vite");
    const port = await freePort();
    server = await preview({
      configFile: resolve(repositoryRoot, "apps/workspace-web/vite.config.ts"),
      root: resolve(repositoryRoot, "apps/workspace-web"),
      mode: "fixture",
      logLevel: "silent",
      preview: { host: "127.0.0.1", port, strictPort: true, headers: staticHeaders() },
    });
    origin = `http://127.0.0.1:${port}`;
  } else {
    const { startEdgeDev } = await import("./edge.mjs");
    server = await startEdgeDev({ protocol: "http" });
    origin = server.origin;
  }
  // Screenshots exist only for failures of this run.
  if (mode === "fixture") rmSync(artifactPath("ui/screenshots"), { recursive: true, force: true });
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  const cases = [];
  const walks = [];
  try {
    const states = (mode === "fixture" ? fixtureCases : edgeCases).filter(matches);
    for (const item of states)
      for (const width of item.widths)
        cases.push(
          await runCase(browser, origin, item, width, { fixture: mode === "fixture", failures }),
        );
    if (mode === "fixture")
      for (const walk of keyboardWalks.filter((w) => selected(`walk/${w.name}`)))
        for (const width of [1440, 390])
          walks.push(
            await runCase(
              browser,
              origin,
              {
                group: "walk",
                name: walk.name,
                path: walk.path,
                scenario: walk.scenario ?? null,
                run: walk.run,
              },
              width,
              { fixture: true, failures },
            ),
          );
  } finally {
    await browser.close();
    if (mode === "fixture") await new Promise((done) => server.httpServer.close(done));
    else await server.stop();
  }
  const report = {
    generated_at: new Date().toISOString(),
    packet: "P14.T01a",
    mode,
    scope:
      mode === "fixture"
        ? "Fixture build under vite preview with the _headers CSP: axe (WCAG 2.0/2.1 A, AA; 2.2 AA; aria-allowed-role), non-text contrast, reflow, targets, reduced motion, CSP and console, plus keyboard walks at 1440 and 390. Automated checks only; not a screen-reader or participant study (P02.T04)."
        : "Production dist under the unbound dev pair: the same state checks on the landing, sign-in and not-found screens.",
    axe: {
      version: JSON.parse(readFileSync(require.resolve("axe-core/package.json"), "utf8")).version,
      tags: axeTags,
      rules: Object.keys(axeRules),
    },
    filter: only,
    totals: {
      state_cases: cases.length,
      keyboard_walks: walks.length,
      passed: [...cases, ...walks].filter((c) => c.passed).length,
      failed: [...cases, ...walks].filter((c) => !c.passed).length,
    },
    cases,
    walks,
  };
  writeArtifact(`ui/${mode === "fixture" ? "check" : "edge"}.json`, report);
  if (failures.length) {
    console.error(failures.slice(0, 60).join("\n"));
    process.exitCode = 1;
  } else
    console.log(`PASS: ${cases.length} state cases and ${walks.length} keyboard walks (${mode}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
