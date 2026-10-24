// P14.T01a §4.12: the bounded accessibility, keyboard and contrast matrix in Chromium.
//   node scripts/ui-checks.mjs fixture   (`npm run ui:check`: the fixture build under
//                                          `vite preview` with the exact _headers CSP)
//   node scripts/ui-checks.mjs edge      (`npm run ui:edge`: the production dist under
//                                          the unbound dev pair)
// Optional: --only=<a>,<b> runs the cases whose group/name contains any of them.
// Each state case checks axe (WCAG 2.0/2.1 A and AA, 2.2 AA, plus the ARIA-in-HTML
// `aria-allowed-role` rule) with zero violations, one visible provisional note, non-text
// contrast of control borders and focus indicators, reflow, the ADR-0032 item 5 target
// floors from docs/design/tokens.json (44 px, and 48 px below 760 px; a checkbox or radio
// is measured by the label that holds it, and on the Sunrise screens under `.sr` so is any
// control inside its label), link blue only on what can be clicked on the Sunrise screens
// (ADR-0032 item 2), reduced motion, CSP and console errors; an entry screen's title
// matches its heading. Keyboard
// walks run at 1440 and 390. Tracing, HAR and video stay off; screenshots exist only for
// failed fixture cases. Reports are verdict-only JSON under ui/ in the artifacts directory.
import { createServer } from "node:net";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { artifactPath, repositoryRoot, writeArtifact } from "./artifacts.mjs";
import { targetFloors } from "./generate-ui-tokens.mjs";

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
/** ADR-0032 item 5: 44 px targets, 48 px on a phone (below the 760 px navigation break). */
export const floors = targetFloors();

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
  // WCAG 2.5.8's inline exception: a link inside a sentence, its size set by the line of
  // text around it. An inline link alone in its block (a row title, a section's action,
  // a link beside a button) is a target like any other, however it is styled.
  const inSentence = (el) => {
    if (el.tagName !== "A" || getComputedStyle(el).display !== "inline") return false;
    let block = el.parentElement;
    while (block && getComputedStyle(block).display === "inline") block = block.parentElement;
    if (!block) return false;
    return block.textContent.trim().length > el.textContent.trim().length;
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
      const { minimum, phone, phoneBelow } = window.__floors;
      const floor = window.innerWidth < phoneBelow ? phone : minimum;
      for (const el of targets) {
        // A checkbox or radio is hit through its label too: measure the label holding it.
        // On the Sunrise screens under `.sr`, any control inside its label is hit through it.
        const box =
          (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) ||
          el.closest(".sr") !== null
            ? (el.closest("label") ?? el)
            : el;
        const rect = box.getBoundingClientRect();
        if (!inSentence(el) && (rect.width < floor || rect.height < floor))
          failures.push(
            `target_size:${el.tagName.toLowerCase()}${el.classList[0] ? "." + el.classList[0] : ""}`,
          );
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
      // ADR-0032 item 2: on a Sunrise screen, text in link blue is always something to click.
      const sunriseRoot = document.querySelector(".sr");
      if (sunriseRoot) {
        const probe = document.createElement("span");
        probe.style.color = "var(--color-link)";
        sunriseRoot.append(probe);
        const linkColour = getComputedStyle(probe).color;
        probe.remove();
        const clickable = 'a[href], button, [role="link"], [role="button"], [role="tab"], label';
        for (const el of document.querySelectorAll(".sr *")) {
          const ownText = [...el.childNodes].some(
            (node) => node.nodeType === 3 && node.textContent.trim() !== "",
          );
          if (!ownText || !visible(el) || el.closest(clickable)) continue;
          if (getComputedStyle(el).color === linkColour)
            failures.push(`link_colour_not_clickable:${el.tagName.toLowerCase()}`);
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
// ADR-0032 Home: the heading greets the person; the scope line names the workspace.
const homeShown = (page, name = "Linen & Form") => page.getByText(`your day at ${name}`).first();
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
const fillSignup = async (page) => {
  await page.getByLabel("Organization name").fill("Linen and Form Ltd");
  await page.getByLabel("Workspace name").fill("Main");
  await page.getByRole("button", { name: "Create organization" }).click();
};
export const fixtureCases = [
  fixtureCase("entry", "sign_in", `/w/${ws}`, { scenario: "session_expired" }),
  // PR-2: the first account read at `/` is a 401 with nothing private shown.
  fixtureCase("entry", "sign_in_landing", "/", { scenario: "session_expired" }),
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
  // T7 PR 16 built Team; the catalog stays a destination this build doesn't have yet.
  fixtureCase("entry", "unavailable_destination", `/w/${ws}/catalog`),
  // M3 PR-1: the Listings agent card on M2 PR-2's connection screen (the sample store's
  // connection): ready, the review of the server-built document, the stop dialog; and the
  // model default under Settings (the `billing` section since T7 PR 16).
  fixtureCase("agents", "listings_card", `/w/${ws}/connections/conn-sample-1`),
  fixtureCase("agents", "listings_review", `/w/${ws}/connections/conn-sample-1`, {
    setup: async (page) => {
      await page.getByRole("button", { name: "Enable Listings agent" }).click();
      await page.getByRole("heading", { name: "Review before enabling" }).waitFor();
    },
  }),
  fixtureCase("agents", "listings_stop", `/w/${ws}/connections/conn-sample-1`, {
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Enable Listings agent" }).click();
      await page.getByRole("button", { name: "Confirm and enable" }).click();
      await page.getByRole("button", { name: "Stop AI work" }).click();
      await page.getByRole("heading", { name: "Stop AI work for this store" }).waitFor();
    },
  }),
  // T7 review F1: every connections read fails once the enable is sent, and its reply is
  // lost. The connection screen reads once per mount, so the review and its Check again
  // stay through the command's re-reads; the sidebar keeps its last connection line; and
  // Check again replays the enable under the same key.
  fixtureCase("agents", "listings_enable_reread_failed", `/w/${ws}/connections/conn-sample-1`, {
    scenario: "listings_enable_reread_failed",
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Enable Listings agent" }).click();
      await page.getByRole("button", { name: "Confirm and enable" }).click();
      const checkAgain = page.getByRole("button", { name: "Check again" });
      await checkAgain.waitFor();
      // Time for the re-reads the command's start and settle trigger to answer.
      await page.waitForTimeout(400);
      expect(await checkAgain.isVisible(), "check_again_kept");
      expect(
        (await page.getByRole("heading", { name: "Review before enabling" }).count()) === 1,
        "review_kept",
      );
      expect(
        (await page
          .locator(".sidebar .sidebar-status", { hasText: "Shopify connected" })
          .count()) === 1,
        "connection_line_kept",
      );
      await checkAgain.click();
      await page.getByRole("heading", { name: "Review before enabling" }).waitFor({
        state: "detached",
      });
      await page.getByText("Active", { exact: true }).first().waitFor();
    },
  }),
  fixtureCase("settings", "model_default", `/w/${ws}/settings/billing`),
  // ADR-0032: a settings page inside the shell's Settings frame, whose card lists every
  // section in the board's order (Activity under Settings, never in the sidebar) and ends
  // with Stop all AI work, which opens Activity (T7 PR 16).
  fixtureCase("settings", "section_frame", `/w/${ws}/settings/people`, {
    setup: async (page) => {
      await page.getByRole("heading", { name: "People and roles" }).waitFor();
      const settings = page.getByRole("navigation", { name: "Settings" });
      expect((await settings.getByRole("link").count()) === 8, "eight_settings_links");
      expect(
        (await settings.getByRole("link", { name: "Activity", exact: true }).count()) === 1,
        "activity_listed",
      );
      expect(
        (await settings.getByRole("link", { name: "Stop all AI work" }).count()) === 1,
        "stop_listed",
      );
      expect(
        (await page.locator('nav[aria-label="Main"]').getByText("Activity").count()) === 0,
        "activity_not_in_sidebar",
      );
    },
  }),
  fixtureCase("account", "form", "/", { scenario: "account_form" }),
  fixtureCase("account", "chooser", "/", { scenario: "account_chooser" }),
  fixtureCase("account", "invite", "/", { scenario: "account_invite" }),
  fixtureCase("account", "rate_limited", "/", {
    scenario: "account_rate_limited",
    setup: async (page) => {
      await fillSignup(page);
      await page.getByText("Too many attempts. Nothing was created.").waitFor();
    },
  }),
  fixtureCase("account", "uncertain", "/", {
    scenario: "account_uncertain",
    setup: async (page) => {
      await fillSignup(page);
      await page.getByRole("button", { name: "Check again" }).waitFor();
    },
  }),
  // Review rows (AC25, §4.10): each setup asserts the behaviour, then the state is checked.
  // A failed account read still offers Sign out.
  fixtureCase("account", "unavailable", "/", {
    scenario: "account_unavailable",
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Retry" }).waitFor();
      expect(await page.getByRole("button", { name: "Sign out" }).isVisible(), "sign_out_shown");
    },
  }),
  // 400 invalid_name marks both name fields.
  fixtureCase("account", "invalid_name", "/", {
    scenario: "account_invalid_name",
    widths: [1440, 390],
    setup: async (page) => {
      await fillSignup(page);
      await page.getByText("Check the highlighted fields and try again.").waitFor();
      expect((await page.getByText("Check this name and try again.").count()) === 2, "marked");
    },
  }),
  // The guard's 400 names no field: nothing is marked, and the copy says so.
  fixtureCase("account", "signup_refused", "/", {
    scenario: "account_signup_refused",
    widths: [1440, 390],
    setup: async (page) => {
      await fillSignup(page);
      await page.getByText("This request was refused.", { exact: false }).waitFor();
      expect((await page.getByText("Check this name and try again.").count()) === 0, "unmarked");
      expect((await page.getByText("Check the highlighted fields").count()) === 0, "no_pointer");
    },
  }),
  // 403: "Creating…" while in flight, then the action stays off and the values stay.
  fixtureCase("account", "signup_denied", "/", {
    scenario: "account_signup_denied",
    widths: [1440, 390],
    setup: async (page) => {
      await fillSignup(page);
      const creating = page.getByRole("button", { name: "Creating…" });
      await creating.waitFor();
      expect(await creating.isDisabled(), "disabled_in_flight");
      await page.getByText("Creating an organization isn't available for this account.").waitFor();
      expect(await page.getByRole("button", { name: "Create organization" }).isDisabled(), "held");
      expect(
        (await page.getByLabel("Organization name").inputValue()) === "Linen and Form Ltd" &&
          (await page.getByLabel("Workspace name").inputValue()) === "Main",
        "values_kept",
      );
    },
  }),
  // 409 already_onboarded: the account is read again and opens the one workspace.
  fixtureCase("account", "already_onboarded", "/", {
    scenario: "account_already_onboarded",
    widths: [1440, 390],
    setup: async (page) => {
      await fillSignup(page);
      await page.waitForURL(`**/w/${ws}`);
      await homeShown(page).waitFor();
    },
  }),
  // P05.T01ab (P04.T01i D5): the api guard's 403 challenge_* is the existing "Couldn't
  // save. Nothing was changed." with Try again, never the terminal refusal.
  fixtureCase("account", "signup_challenge_failed", "/", {
    scenario: "account_challenge_failed",
    widths: [1440, 390],
    setup: async (page) => {
      await fillSignup(page);
      await page.getByText("Couldn't save. Nothing was changed.").waitFor();
      expect(await page.getByRole("button", { name: "Try again" }).isEnabled(), "try_again");
      expect(
        await page.getByRole("button", { name: "Create organization" }).isEnabled(),
        "not_held",
      );
      expect((await page.getByText("isn't available for this account").count()) === 0, "open");
      expect(
        (await page.getByLabel("Organization name").inputValue()) === "Linen and Form Ltd",
        "values_kept",
      );
    },
  }),
  // A widget that yields no token: the same copy, and nothing is sent (the scenario
  // would deny a send).
  fixtureCase("account", "signup_no_token", "/", {
    scenario: "account_challenge_unavailable",
    widths: [1440, 390],
    setup: async (page) => {
      await fillSignup(page);
      await page.getByText("Couldn't save. Nothing was changed.").waitFor();
      expect((await page.getByText("isn't available for this account").count()) === 0, "unsent");
    },
  }),
  // The guard's per-address 429 (Retry-After: 60): the existing signup hold.
  fixtureCase("account", "signup_guard_rate_limited", "/", {
    scenario: "account_guard_rate_limited",
    widths: [1440, 390],
    setup: async (page) => {
      await fillSignup(page);
      await page.getByText("Nothing was created. You can try again in 1 minute.").waitFor();
      expect(await page.getByRole("button", { name: "Create organization" }).isDisabled(), "held");
    },
  }),
  fixtureCase("home", "ready", `/w/${ws}`),
  // A denied open-questions read is never an all-clear: the scope line stays neutral, no
  // primary is offered, and the Needs you card carries the denial (the AC26 first-run Home).
  fixtureCase("home", "partial_denied", `/w/${ws}`, {
    scenario: "home_partial_denied",
    setup: async (page) => {
      await page.locator('[data-card="needs"] .state-denied').waitFor();
      await homeShown(page).waitFor();
      expect((await page.getByText("Nothing needs you").count()) === 0, "no_false_all_clear");
      expect((await page.locator("main .title-row .button-primary").count()) === 0, "no_primary");
    },
  }),
  fixtureCase("home", "loading", `/w/${ws}`, { scenario: "loading" }),
  // T7 review F2: Home opens offline, so neither Home nor the shell shows a count; Retry
  // on Needs you reads the shell's copy again too, so the Inbox count appears with Home's
  // "Review N items".
  fixtureCase("home", "offline_retry", `/w/${ws}`, {
    scenario: "home_offline_retry",
    setup: async (page) => {
      const retry = page.locator('[data-card="needs"]').getByRole("button", { name: "Retry" });
      await retry.waitFor();
      expect((await page.locator(".count-pill").count()) === 0, "no_count_while_offline");
      await retry.click();
      await page.locator("main .title-row .button-primary", { hasText: /^Review / }).waitFor();
      await page.locator(".topbar .count-pill").waitFor({ state: "attached" });
      expect(
        (await page.locator(".sidebar .count-pill").count()) === 1,
        "sidebar_count_after_retry",
      );
    },
  }),
  // ADR-0032 Home: nothing waiting (Ask Morrow is the page's one primary), and the
  // default-off preview of the board's sample sections, the agent characters among them.
  fixtureCase("home", "nothing_waiting", `/w/${ws}`, {
    scenario: "empty",
    setup: async (page) => {
      await page.getByText("Nothing needs you right now. Here's your day at").waitFor();
      expect(
        (await page.locator("main .button-primary").count()) === 1 &&
          (await page.locator("main .button-primary").textContent()).includes("Ask Morrow"),
        "one_primary_ask",
      );
    },
  }),
  fixtureCase("home", "preview", `/w/${ws}`, {
    scenario: "home_preview",
    setup: async (page, width) => {
      await page.getByRole("heading", { name: "Yesterday at a glance" }).waitFor();
      expect((await page.locator("main .button-primary").count()) === 1, "one_primary");
      if (width >= 760) {
        expect(
          (await page
            .getByRole("link", { name: /^Business Analyst\s*, agent\s*, sample data$/ })
            .count()) === 1,
          "team_member_named_as_agent_and_sample",
        );
        // Sample rows in the sidebar say so on screen: pinned projects, Team, credits.
        const tags = page.locator(".sidebar .nav-sample-tag", { hasText: "Sample data" });
        expect((await tags.count()) === 3, "sidebar_samples_labelled");
        for (let i = 0; i < 3; i++) expect(await tags.nth(i).isVisible(), "sample_tag_visible");
        expect(
          (await page.getByRole("link", { name: /credits left\s*,\s*Sample data$/ }).count()) === 1,
          "credits_named_as_sample",
        );
      }
    },
  }),
  fixtureCase("task", "brief", `/w/${ws}/work/task-titles`),
  fixtureCase("task", "questions", `/w/${ws}/work/task-titles`, {
    setup: (page) => page.getByRole("tab", { name: "Questions" }).click(),
  }),
  // An answered question's answer, shown on request (no landmark, no skipped heading).
  fixtureCase("task", "questions_answer", `/w/${ws}/work/task-titles`, {
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("tab", { name: "Questions" }).click();
      await page.getByRole("button", { name: "Show answer" }).click();
      await page.getByText("Yes, after the product type").waitFor();
      expect(
        (await page.getByRole("button", { name: "Hide answer" }).getAttribute("aria-expanded")) ===
          "true",
        "expanded",
      );
      expect(
        (await page.locator("ul.item-list :is(section, h2, h3, h4)").count()) === 0,
        "no_region_or_heading",
      );
    },
  }),
  fixtureCase("task", "ready_uncertain", `/w/${ws}/work/task-titles`, {
    scenario: "uncertain",
    setup: async (page) => {
      await page.getByRole("button", { name: "Mark ready" }).click();
      await page.getByRole("button", { name: "Check again" }).waitFor();
    },
  }),
  fixtureCase("task", "ready_denied", `/w/${ws}/work/task-titles`, {
    scenario: "ready_denied",
    setup: async (page) => {
      await page.getByRole("button", { name: "Mark ready" }).click();
      await page.getByText("This operation is not permitted.").waitFor();
    },
  }),
  ...["ready", "empty", "denied", "offline", "reentry"].map((scenario) =>
    fixtureCase("work", scenario, `/w/${ws}/work`, { scenario }),
  ),
  fixtureCase("work", "conflict", `/w/${ws}/work`, { scenario: "conflict", setup: fillGoal }),
  fixtureCase("work", "uncertain", `/w/${ws}/work`, { scenario: "uncertain", setup: fillGoal }),
  fixtureCase("inbox", "inbox", `/w/${ws}/inbox`),
  fixtureCase("inbox", "question_open", `/w/${ws}/inbox/questions/q-source`),
  fixtureCase("inbox", "question_answered", `/w/${ws}/inbox/questions/q-titles`),
  fixtureCase("inbox", "empty", `/w/${ws}/inbox`, { scenario: "empty" }),
  fixtureCase("inbox", "question_expired", `/w/${ws}/inbox/questions/q-source`, {
    scenario: "question_expired",
  }),
  fixtureCase("inbox", "question_cancelled", `/w/${ws}/inbox/questions/q-returns`),
  // v1 PR 3: the review screen of the seeded proposal, approving and applying it (the
  // fixture "writes" at once), and the task's apply history.
  fixtureCase("review", "pending", `/w/${ws}/review/proposal-sample-1`),
  fixtureCase("review", "applied", `/w/${ws}/review/proposal-sample-1`, {
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Approve all" }).click();
      await page.getByRole("button", { name: "Apply to Shopify" }).click();
      // The apply settles every product, then the screen shows the history.
      await page.getByRole("heading", { name: "Changes applied" }).waitFor();
    },
  }),
  // Review F2: an uncertain product offers Check again and "I checked it in Shopify"; setting
  // it aside shows "Checked by you".
  fixtureCase("review", "uncertain", `/w/${ws}/review/proposal-sample-1`, {
    scenario: "review_uncertain",
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Approve all" }).click();
      await page.getByRole("button", { name: "Apply to Shopify" }).click();
      await page.getByRole("button", { name: "I checked it in Shopify" }).waitFor();
    },
  }),
  fixtureCase("review", "set_aside", `/w/${ws}/review/proposal-sample-1`, {
    scenario: "review_uncertain",
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Approve all" }).click();
      await page.getByRole("button", { name: "Apply to Shopify" }).click();
      await page.getByRole("button", { name: "I checked it in Shopify" }).click();
      await page.getByText("Checked by you").first().waitFor();
    },
  }),
  fixtureCase("task", "applied_history", `/w/${ws}/work/task-titles`, {
    widths: [1440, 390],
    setup: (page) => page.getByRole("tab", { name: "Changes applied" }).click(),
  }),
  // v1 PR 4: "Approve several at once" with the solo owner's one phrase, and the history's
  // Undo after an apply (the undo is a new change, waiting for approval).
  fixtureCase("review", "batch", `/w/${ws}/review/proposal-sample-1`, {
    scenario: "review_batch",
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Approve several at once" }).click();
      await page.getByRole("button", { name: "Approve these 2 changes" }).waitFor();
    },
  }),
  fixtureCase("task", "undo_history", `/w/${ws}/review/proposal-sample-1`, {
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Approve all" }).click();
      await page.getByRole("button", { name: "Apply to Shopify" }).click();
      await page.getByRole("heading", { name: "Changes applied" }).waitFor();
      await page.getByRole("link", { name: "Open the task" }).click();
      await page.getByRole("tab", { name: "Changes applied" }).click();
      await page.getByRole("button", { name: "Undo" }).first().click();
      await page.getByText("Morrow made a change back to the earlier values.").waitFor();
    },
  }),
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
// M2 PR-2: the connections screens. The fixture continuation rides in the fragment, as the
// connector's redirect sends it; the app reads it once and replaces the address.
const handoffPath = `/w/${ws}/connections#handoff=Hx${"1".repeat(40)}A`;
const linkButton = (page) => page.getByRole("button", { name: "Link store" });
fixtureCases.push(
  fixtureCase("connections", "linked", `/w/${ws}/connections`),
  fixtureCase("connections", "offered", `/w/${ws}/connections`, {
    widths: [1440, 390, 320],
    scenario: "connections_offered",
    setup: async (page) => {
      const link = page.getByRole("link", { name: "Open the install link" });
      await link.waitFor();
      expect((await link.getAttribute("target")) === "_blank", "new_tab");
      expect((await link.getAttribute("rel")) === "noopener noreferrer", "no_opener");
    },
  }),
  fixtureCase("connections", "not_permitted", `/w/${ws}/connections`, {
    widths: [1440, 390],
    scenario: "connections_not_permitted",
  }),
  fixtureCase("connections", "route_not_ready", `/w/${ws}/connections`, {
    widths: [1440, 390],
    scenario: "connections_route_not_ready",
  }),
  fixtureCase("connections", "unlinked", `/w/${ws}/connections`, {
    widths: [1440, 390],
    scenario: "connections_unlinked",
    setup: (page) =>
      page
        .getByText("Reopen Morrow from your Shopify admin to finish connecting")
        .first()
        .waitFor(),
  }),
  fixtureCase("connections", "detail", `/w/${ws}/connections/conn-sample-1`, {
    widths: [1440, 390],
  }),
  // v1 PR 2: "Disconnect store": the dialog (what happens, the reason, the reconnect note)
  // and the disconnected connection.
  fixtureCase("connections", "disconnect_dialog", `/w/${ws}/connections/conn-sample-1`, {
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Disconnect store" }).click();
      await page.getByRole("heading", { name: "Disconnect this store from Morrow?" }).waitFor();
    },
  }),
  fixtureCase("connections", "disconnected", `/w/${ws}/connections/conn-sample-1`, {
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Disconnect store" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Reason").fill("Moving to a new store");
      await dialog.getByRole("button", { name: "Disconnect store" }).click();
      await page.getByText("Disconnected in Morrow.").first().waitFor();
    },
  }),
  fixtureCase("connections", "handoff_confirm", handoffPath, {
    scenario: "connections_handoff",
    setup: async (page) => {
      await linkButton(page).waitFor();
      // The token left the address before anything rendered.
      expect(new URL(page.url()).hash === "", "fragment_replaced");
    },
  }),
  fixtureCase("connections", "handoff_linked", handoffPath, {
    widths: [1440, 390],
    scenario: "connections_handoff",
    setup: async (page) => {
      await linkButton(page).click();
      await page.getByText("Store linked.").first().waitFor();
      await page.getByText("Connected", { exact: true }).first().waitFor();
    },
  }),
  fixtureCase("connections", "handoff_route", handoffPath, {
    widths: [1440, 390],
    scenario: "connections_handoff_route",
    setup: (page) => page.getByText("Subscribe before connecting a store.").first().waitFor(),
  }),
  fixtureCase("connections", "handoff_expired", handoffPath, {
    widths: [1440, 390],
    scenario: "connections_handoff_expired",
    setup: (page) => page.getByText("This connection link expired").first().waitFor(),
  }),
  fixtureCase("connections", "link_uncertain", handoffPath, {
    widths: [1440, 390],
    scenario: "connections_link_uncertain",
    setup: async (page) => {
      await linkButton(page).click();
      await page.getByRole("button", { name: "Check again" }).waitFor();
    },
  }),
);
// T7 PR 19: the project screens, composed only in the projects preview scenarios.
const preview = "projects_preview";
fixtureCases.push(
  fixtureCase("projects", "overview", `/w/${ws}/work`, { scenario: preview }),
  fixtureCase("projects", "tasks_board", `/w/${ws}/work`, {
    scenario: preview,
    setup: (page) => page.getByRole("tab", { name: /^Tasks/ }).click(),
  }),
  fixtureCase("projects", "tasks_list", `/w/${ws}/work`, {
    scenario: preview,
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.getByRole("button", { name: "List" }).click();
    },
  }),
  fixtureCase("projects", "repeating", `/w/${ws}/work`, {
    scenario: preview,
    setup: (page) => page.getByRole("tab", { name: /^Repeating/ }).click(),
  }),
  fixtureCase("projects", "tell_morrow_dialog", `/w/${ws}/work`, {
    scenario: preview,
    widths: [1440, 390],
    setup: (page) => page.getByRole("button", { name: "New project" }).click(),
  }),
  fixtureCase("projects", "set_up_yourself_dialog", `/w/${ws}/work`, {
    scenario: preview,
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "New project" }).click();
      await page.getByRole("button", { name: "Set it up yourself" }).click();
    },
  }),
  fixtureCase("projects", "project", `/w/${ws}/projects/project-tote`, {
    scenario: preview,
    // Review F8: the page heading's name is the title alone; the health badge sits beside it.
    setup: (page) =>
      page
        .getByRole("heading", { level: 1, name: "Everyday Tote in AI answers", exact: true })
        .waitFor({ timeout: 5000 }),
  }),
  fixtureCase("projects", "project_ended", `/w/${ws}/projects/project-summer`, {
    scenario: preview,
  }),
  fixtureCase("projects", "area", `/w/${ws}/projects/area-stock`, { scenario: preview }),
  fixtureCase("projects", "project_teammate", `/w/${ws}/projects/project-tote`, {
    scenario: "projects_teammate",
  }),
  fixtureCase("projects", "goal_drawer", `/w/${ws}/projects/project-tote`, {
    scenario: preview,
    widths: [1440, 390],
    setup: (page) =>
      page.getByRole("button", { name: /Everyday Tote’s page is complete: open details/ }).click(),
  }),
  fixtureCase("projects", "stop_dialog", `/w/${ws}/projects/project-tote`, {
    scenario: preview,
    widths: [1440, 390],
    setup: (page) => page.getByRole("button", { name: "Stop steps" }).click(),
  }),
  fixtureCase("projects", "plan_change", `/w/${ws}/projects/project-tote`, {
    scenario: preview,
    setup: async (page) => {
      await page.getByRole("button", { name: "Plan next steps" }).click();
      await page.getByRole("button", { name: "Apply changes" }).waitFor();
    },
  }),
  fixtureCase("projects", "ask_choice", `/w/${ws}/work`, {
    scenario: preview,
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "New project" }).click();
      await page
        .getByLabel("What do you want to get done, and by when?")
        .fill("Rank in AI answers");
      await page.getByRole("button", { name: "Send to Morrow" }).click();
      await page.getByRole("heading", { name: "Which product?" }).waitFor();
    },
  }),
  fixtureCase("projects", "ask_card", `/w/${ws}/ask/conv-sample`, { scenario: preview }),
  fixtureCase("projects", "start_stale", `/w/${ws}/ask/conv-sample`, {
    scenario: "projects_start_stale",
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Start project" }).click();
      await page.getByText("This plan changed since you opened it").waitFor();
    },
  }),
  fixtureCase("projects", "start_uncertain", `/w/${ws}/ask/conv-sample`, {
    scenario: "projects_start_uncertain",
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Start project" }).click();
      await page.getByRole("button", { name: "Check again" }).waitFor();
    },
  }),
  // A start refused without the server's words says who may start it, not "it changed".
  fixtureCase("projects", "start_denied", `/w/${ws}/ask/conv-sample`, {
    scenario: "projects_start_denied",
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Start project" }).click();
      await page.getByText("Only the person who asked can start this plan.").waitFor();
    },
  }),
  // Plan next steps on a project a teammate changed: the 409 re-reads the project, so the
  // second tap carries the new revision and Morrow is asked.
  fixtureCase("projects", "plan_next_stale", `/w/${ws}/projects/project-tote`, {
    scenario: "projects_changed_meanwhile",
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Plan next steps" }).click();
      await page
        .getByText("This project changed since you opened it. Look it over, then ask again.")
        .waitFor();
      await page.getByRole("button", { name: "Plan next steps" }).click();
      await page.getByRole("button", { name: "Apply changes" }).waitFor();
    },
  }),
  // Sending nothing says why, beside the field (WCAG 3.3.1).
  fixtureCase("projects", "composer_empty", `/w/${ws}/projects/project-tote`, {
    scenario: preview,
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByText("Write a message first.").waitFor();
      const described = await page
        .getByLabel("Message", { exact: true })
        .getAttribute("aria-describedby");
      if (!described) throw Error("composer_error_not_described");
    },
  }),
  fixtureCase("projects", "ask_other_empty", `/w/${ws}/work`, {
    scenario: preview,
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "New project" }).click();
      await page
        .getByLabel("What do you want to get done, and by when?")
        .fill("Rank in AI answers");
      await page.getByRole("button", { name: "Send to Morrow" }).click();
      await page.getByRole("button", { name: "Something else…" }).click();
      await page.getByRole("button", { name: "Send", exact: true }).first().click();
      await page.getByText("Write your answer first.").waitFor();
    },
  }),
  // "Ask Morrow privately instead" opens a new private Ask, not the Listings run form.
  fixtureCase("projects", "ask_privately", `/w/${ws}/projects/project-tote`, {
    scenario: preview,
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Ask Morrow privately instead" }).click();
      await page.getByRole("dialog", { name: "Tell Morrow what you want to achieve" }).waitFor();
    },
  }),
  // Edit refused as stale keeps the dialog open with its notice, and Save waits for a
  // fresh form.
  fixtureCase("projects", "edit_stale", `/w/${ws}/ask/conv-sample`, {
    scenario: "projects_revise_stale",
    widths: [1440, 390],
    setup: async (page) => {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByRole("button", { name: "Save changes" }).click();
      await page
        .getByText(
          "This plan changed since you opened it. Close this, look it over, then edit again.",
        )
        .waitFor();
      if (!(await page.getByRole("dialog", { name: "Change the plan" }).isVisible()))
        throw Error("edit_dialog_closed_on_conflict");
    },
  }),
);
// T7 PR 16 (Sunrise): Team, an agent's page, Add agents and its consent, Settings, Shop
// knowledge and Files, on fixtures (the HTTP build leaves their reads uncomposed).
const two = [1440, 390];
fixtureCases.push(
  fixtureCase("team", "team", `/w/${ws}/agents`),
  fixtureCase("team", "member", `/w/${ws}/agents`, { widths: two, scenario: "team_member" }),
  fixtureCase("team", "empty", `/w/${ws}/agents`, { widths: two, scenario: "empty" }),
  fixtureCase("team", "not_in_build", `/w/${ws}/agents`, {
    widths: two,
    scenario: "not_in_build",
  }),
  fixtureCase("team", "thinking_dialog", `/w/${ws}/agents`, {
    widths: two,
    setup: async (page) => {
      await page.getByRole("button", { name: "Change how Business Analyst thinks" }).click();
      await page.getByRole("dialog", { name: "Change how Business Analyst thinks" }).waitFor();
    },
  }),
  // A real 409 (a teammate's change landed first): the dialog shows the reread choice, and
  // the next save, of the reread revision, goes through.
  fixtureCase("team", "thinking_conflict", `/w/${ws}/agents`, {
    widths: [1440],
    scenario: "team_thinking_conflict",
    setup: async (page) => {
      const name = "Change how Business Analyst thinks";
      await page.getByRole("button", { name }).click();
      const dialog = page.getByRole("dialog", { name });
      await dialog.getByRole("radio", { name: /Opus 5\.5/ }).check();
      await dialog.getByRole("button", { name: "Save" }).click();
      await dialog.getByText("This changed since you opened it.").waitFor();
      // The reread lands a few renders after the 409's message (as on notifications_conflict).
      const reread = await dialog
        .getByRole("radio", { name: /Haiku 5\.5/, checked: true })
        .waitFor({ timeout: 5000 })
        .then(
          () => true,
          () => false,
        );
      expect(reread, "reread_model");
      expect(await dialog.getByRole("radio", { name: /^Medium/ }).isChecked(), "reread_effort");
      await dialog.getByRole("radio", { name: /Opus 5\.5/ }).check();
      await dialog.getByRole("button", { name: "Save" }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByText("Saved. From its next job, Business Analyst uses").waitFor();
    },
  }),
  // An unknown outcome doesn't trap the dialog: Escape closes it, and the shell says the
  // change may have been saved.
  fixtureCase("team", "thinking_uncertain_closed", `/w/${ws}/agents`, {
    widths: [1440],
    scenario: "team_thinking_uncertain",
    setup: async (page) => {
      const name = "Change how Business Analyst thinks";
      await page.getByRole("button", { name }).click();
      const dialog = page.getByRole("dialog", { name });
      await dialog.getByRole("radio", { name: /Opus 5\.5/ }).check();
      await dialog.getByRole("button", { name: "Save" }).click();
      await dialog.getByRole("button", { name: "Check again" }).waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.getByText("(a change to how a helper thinks) may have been saved").waitFor();
    },
  }),
  fixtureCase("team", "agent", `/w/${ws}/agents/agent-listings`),
  // A member sees the Listings agent's setting (the workspace default) and who may change it.
  fixtureCase("team", "agent_listings_member", `/w/${ws}/agents/agent-listings`, {
    widths: [1440],
    scenario: "team_member",
    setup: async (page) => {
      await page.getByText("can change this.").first().waitFor();
      expect((await page.getByRole("radio").count()) === 0, "no_controls");
      expect((await page.getByRole("button", { name: "Save" }).count()) === 0, "no_save");
    },
  }),
  // The Listings agent's choice is the workspace default: above the member ceiling it
  // can't be saved here.
  fixtureCase("team", "agent_over_limit", `/w/${ws}/agents/agent-listings`, {
    widths: two,
    setup: async (page) => {
      await page.getByRole("radio", { name: /Opus 5\.5/ }).check();
      await page.getByText("doesn’t fit the spending limit").waitFor();
      expect(await page.getByRole("button", { name: "Save" }).isDisabled(), "save_held");
    },
  }),
  fixtureCase("team", "agent_member", `/w/${ws}/agents/agent-analyst`, {
    widths: two,
    scenario: "team_member",
    setup: async (page) => {
      await page.getByText("Only Maya Chen, the Owner, or an Admin can change this.").waitFor();
      expect((await page.getByRole("radio").count()) === 0, "no_controls");
    },
  }),
  fixtureCase("team", "add_agents", `/w/${ws}/agent-store`),
  fixtureCase("team", "add_consent", `/w/${ws}/agent-store/release-marketing`, {
    widths: two,
    setup: async (page) => {
      await page.getByRole("button", { name: "Add Marketing" }).click();
      await page.getByRole("dialog", { name: "Add Marketing to Linen & Form?" }).waitFor();
    },
  }),
  fixtureCase("team", "add_sent", `/w/${ws}/agent-store/release-marketing`, {
    widths: two,
    setup: async (page) => {
      await page.getByRole("button", { name: "Add Marketing" }).click();
      await page.getByRole("button", { name: "Send to Leo Martin to review" }).click();
      await page.getByText("Marketing was sent to Leo Martin to review").waitFor();
    },
  }),
  fixtureCase("team", "add_uncertain", `/w/${ws}/agent-store/release-marketing`, {
    widths: two,
    scenario: "team_add_uncertain",
    setup: async (page) => {
      await page.getByRole("button", { name: "Add Marketing" }).click();
      await page.getByRole("button", { name: "Send to Leo Martin to review" }).click();
      await page.getByRole("button", { name: "Check again" }).waitFor();
    },
  }),
  fixtureCase("team", "add_uncertain_closed", `/w/${ws}/agent-store/release-marketing`, {
    widths: [1440],
    scenario: "team_add_uncertain",
    setup: async (page) => {
      await page.getByRole("button", { name: "Add Marketing" }).click();
      await page.getByRole("button", { name: "Send to Leo Martin to review" }).click();
      await page.getByRole("button", { name: "Check again" }).waitFor();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByText("(adding an agent) may have been saved").waitFor();
    },
  }),
  fixtureCase("settings", "home", `/w/${ws}/settings`, { widths: two }),
  fixtureCase("settings", "plan", `/w/${ws}/settings/usage`),
  fixtureCase("settings", "plan_by_helper", `/w/${ws}/settings/usage`, {
    widths: two,
    setup: (page) => page.getByRole("tab", { name: "By helper" }).click(),
  }),
  fixtureCase("settings", "email", `/w/${ws}/settings/stores`),
  fixtureCase("settings", "email_member", `/w/${ws}/settings/stores`, {
    widths: two,
    scenario: "team_member",
  }),
  fixtureCase("settings", "notifications", `/w/${ws}/settings/notifications`),
  // A change shows the save bar; the time zone is the Owner's alone.
  fixtureCase("settings", "notifications_unsaved", `/w/${ws}/settings/notifications`, {
    widths: two,
    setup: async (page) => {
      await page.getByRole("switch", { name: "Email me each Monday project update" }).click();
      await page.getByText("You have unsaved changes").waitFor();
    },
  }),
  // After a save nothing is unsaved: the bar's landmark name doesn't say otherwise.
  fixtureCase("settings", "notifications_saved", `/w/${ws}/settings/notifications`, {
    widths: [1440],
    setup: async (page) => {
      await page.getByRole("switch", { name: "Email me each Monday project update" }).click();
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByText("Notifications saved.").waitFor();
      expect(
        (await page.getByRole("region", { name: "You have unsaved changes" }).count()) === 0,
        "no_unsaved_landmark",
      );
      expect(
        (await page.getByRole("region", { name: "Save notifications" }).count()) === 1,
        "save_bar_named",
      );
    },
  }),
  // A save the record moved past (saved from another tab first): the real 409's reread
  // replaces the draft, so the screen shows what the server has, with nothing unsaved.
  // The message is drawn from the 409 itself; the reread is a second request that lands a
  // few renders later, so the check waits (bounded) for it rather than reading the switch
  // between the two (on CI's Linux runner the immediate read came first, run 40058758297).
  fixtureCase("settings", "notifications_conflict", `/w/${ws}/settings/notifications`, {
    widths: two,
    scenario: "notifications_conflict",
    setup: async (page) => {
      const mondayName = "Email me each Monday project update";
      const monday = page.getByRole("switch", { name: mondayName });
      const hour = page.getByLabel("Send at");
      const hourBefore = await hour.inputValue();
      await monday.click();
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByText("These settings changed since you opened them.").waitFor();
      const replaced = await page
        .getByRole("switch", { name: mondayName, checked: true })
        .waitFor({ timeout: 5000 })
        .then(
          () => true,
          () => false,
        );
      expect(replaced, "draft_replaced");
      // What the server has now (the other tab moved the summary hour), not just the draft gone.
      expect((await hour.inputValue()) !== hourBefore, "reread_shown");
      expect(
        (await page.getByRole("region", { name: "You have unsaved changes" }).count()) === 0,
        "nothing_unsaved",
      );
    },
  }),
  fixtureCase("settings", "notifications_member", `/w/${ws}/settings/notifications`, {
    widths: two,
    scenario: "team_member",
    setup: async (page) => {
      await page.getByText("Only Maya Chen (Owner) can change the time zone.").waitFor();
      expect(await page.getByLabel("Linen & Form’s time zone").isDisabled(), "zone_held");
    },
  }),
  // Activity: Stop all AI work on top, wired to the Listings agent's own stop.
  fixtureCase("settings", "activity", `/w/${ws}/settings/governance`),
  fixtureCase("settings", "activity_on", `/w/${ws}/settings/governance`, {
    widths: two,
    scenario: "stop_all",
  }),
  fixtureCase("settings", "stop_dialog", `/w/${ws}/settings/governance`, {
    widths: two,
    scenario: "stop_all",
    setup: async (page) => {
      await page.getByRole("button", { name: "Stop all AI work" }).click();
      const dialog = page.getByRole("dialog", { name: "Stop all AI work?" });
      await dialog.waitFor();
      const confirm = dialog.getByRole("button", { name: "Stop all AI work" });
      expect(await confirm.isDisabled(), "confirm_held_until_typed");
      await dialog.getByLabel("To confirm, type: stop").fill("stop");
      expect(!(await confirm.isDisabled()), "confirm_after_typed");
    },
  }),
  fixtureCase("settings", "stopped", `/w/${ws}/settings/governance`, {
    widths: two,
    scenario: "stop_all",
    setup: async (page) => {
      await page.getByRole("button", { name: "Stop all AI work" }).click();
      const dialog = page.getByRole("dialog", { name: "Stop all AI work?" });
      await dialog.getByLabel("To confirm, type: stop").fill("stop");
      await dialog.getByRole("button", { name: "Stop all AI work" }).click();
      await page.getByRole("heading", { name: "Listings is stopped on 1 store" }).waitFor();
    },
  }),
  // A lost reply is "not confirmed" with Check again (the same key), never "stopped".
  fixtureCase("settings", "stop_uncertain", `/w/${ws}/settings/governance`, {
    widths: two,
    scenario: "stop_all_uncertain",
    setup: async (page) => {
      await page.getByRole("button", { name: "Stop all AI work" }).click();
      const dialog = page.getByRole("dialog", { name: "Stop all AI work?" });
      await dialog.getByLabel("To confirm, type: stop").fill("stop");
      await dialog.getByRole("button", { name: "Stop all AI work" }).click();
      await dialog.getByRole("button", { name: "Check again" }).waitFor();
    },
  }),
  fixtureCase("settings", "people", `/w/${ws}/settings/people`, { widths: two }),
  fixtureCase("library", "knowledge", `/w/${ws}/knowledge`),
  fixtureCase("library", "knowledge_lessons", `/w/${ws}/knowledge`, {
    widths: two,
    setup: (page) => page.getByRole("tab", { name: /Lessons/ }).click(),
  }),
  fixtureCase("library", "files", `/w/${ws}/assets`),
  fixtureCase("library", "files_empty", `/w/${ws}/assets`, { widths: two, scenario: "empty" }),
);
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
  // T7 PR 16: "Change" on Team keeps focus in its dialog and returns it on Escape; adding
  // an agent by keyboard reaches the server-built document and confirms it.
  {
    name: "thinking_dialog",
    path: `/w/${ws}/agents`,
    run: async (page) => {
      const change = "Change how Business Analyst thinks";
      await page.getByRole("button", { name: change }).waitFor();
      await tabTo(page, (a) => a.text === change, 80);
      await page.keyboard.press("Enter");
      await page.getByRole("dialog", { name: change }).waitFor();
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        expect((await active(page)).inDialog, "focus_left_dialog");
      }
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      expect((await active(page)).text === change, "dialog_focus_restore");
    },
  },
  // Stop all AI work by keyboard: the dialog opens on the typed confirmation, Escape
  // closes it with nothing sent and focus back on the opener; typing "stop" and Enter stops.
  {
    name: "stop_all",
    path: `/w/${ws}/settings/governance`,
    scenario: "stop_all",
    run: async (page) => {
      const open = "Stop all AI work";
      await page.getByRole("button", { name: open }).waitFor();
      await tabTo(page, (a) => a.tag === "BUTTON" && a.text === open, 80);
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Stop all AI work?" });
      await dialog.waitFor();
      expect((await active(page)).tag === "INPUT", "focus_on_confirmation");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect((await active(page)).text === open, "dialog_focus_restore");
      await page.keyboard.press("Enter");
      await dialog.waitFor();
      await page.keyboard.type("stop");
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Listings is stopped on 1 store" }).waitFor();
      await dialog.waitFor({ state: "hidden" });
      // The opener is gone after the stop: focus is on the result, not the page body.
      await page.waitForFunction(() => document.activeElement?.tagName === "H3");
      expect((await active(page)).text === "Listings is stopped on 1 store", "focus_on_result");
    },
  },
  // A stop whose reply is lost: the dialog stays, and once the typed word is gone focus is on
  // each store's outcome inside it, then on Check again; after that reply it stays inside.
  {
    name: "stop_all_uncertain",
    path: `/w/${ws}/settings/governance`,
    scenario: "stop_all_uncertain",
    run: async (page) => {
      const open = "Stop all AI work";
      await page.getByRole("button", { name: open }).waitFor();
      await tabTo(page, (a) => a.tag === "BUTTON" && a.text === open, 80);
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Stop all AI work?" });
      await dialog.waitFor();
      await page.keyboard.type("stop");
      await page.keyboard.press("Enter");
      const checkAgain = dialog.getByRole("button", { name: "Check again" });
      await checkAgain.waitFor();
      const after = await active(page);
      expect(after.inDialog, "focus_left_dialog");
      expect(after.role === "group", "focus_on_outcome");
      await tabTo(page, (a) => a.tag === "BUTTON" && a.text === "Check again", 10);
      await page.keyboard.press("Enter");
      await checkAgain.waitFor({ state: "detached" });
      await dialog.getByText("Listings is stopped on 1 store.").waitFor();
      expect((await active(page)).inDialog, "focus_left_dialog_after_check");
    },
  },
  {
    name: "add_agent",
    path: `/w/${ws}/agent-store/release-marketing`,
    run: async (page) => {
      await page.getByRole("button", { name: "Add Marketing" }).waitFor();
      await tabTo(page, (a) => a.text === "Add Marketing");
      await page.keyboard.press("Enter");
      await page.getByRole("dialog", { name: "Add Marketing to Linen & Form?" }).waitFor();
      await tabTo(page, (a) => a.text === "Send to Leo Martin to review");
      await page.keyboard.press("Enter");
      await page.getByText("Marketing was sent to Leo Martin to review").waitFor();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      // The add button is gone once the agent waits for review: focus is on the result.
      await page.getByRole("button", { name: "Add Marketing" }).waitFor({ state: "detached" });
      expect(
        (await active(page)).text.startsWith("Marketing was sent to Leo Martin to review"),
        "focus_on_result",
      );
    },
  },
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
      await tabTo(page, (a) => a.tag === "A" && a.text === "Projects");
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/w/${ws}/work`);
      if (width < 760) {
        await page.getByRole("button", { name: "Open navigation" }).click();
      }
      const current = await page
        .locator('nav[aria-label="Main"] [aria-current="page"]')
        .textContent();
      expect(current.trim() === "Projects", "aria_current");
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
      // The last tab is Runs when the fixture composes runs.listOfTask (M3 PR-2), else Questions.
      const names = (await page.getByRole("tab").allTextContents()).map((n) => n.trim());
      await page.keyboard.press("End");
      expect(names.length >= 2 && (await active(page)).text === names[names.length - 1], "end_key");
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
    // T7 PR 19: a person starts a plan card by keyboard; the card's one tap opens the
    // project it created.
    name: "start_project",
    path: `/w/${ws}/ask/conv-sample`,
    scenario: "projects_preview",
    run: async (page) => {
      await tabTo(page, (a) => a.text === "Start project", 120);
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/w/${ws}/projects/project-new-*`);
      await page.getByRole("heading", { name: /Linen Shirt in AI answers/ }).waitFor();
    },
  },
  {
    // T7 PR 19 review F2: Stop steps by keyboard. The header button and the dialog are
    // gone once the page reads the project again; the confirmation is said in the page's
    // status region and focus rests on the page title, not on <body>.
    name: "stop_steps_focus",
    path: `/w/${ws}/projects/project-tote`,
    scenario: "projects_preview",
    run: async (page) => {
      await tabTo(page, (a) => a.text === "Stop steps", 120);
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor();
      await tabTo(page, (a) => a.inDialog && a.text === "Stop steps", 8);
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page
        .getByRole("button", { name: "Stop steps", exact: true })
        .waitFor({ state: "detached" });
      const said = await page
        .getByRole("status")
        .filter({ hasText: /^Steps stopped\. \d+ repeating tasks? turned off/ })
        .count();
      expect(said === 1, "stop_confirmation_not_said");
      const now = await active(page);
      expect(now.tag === "H1" && now.text === "Everyday Tote in AI answers", "focus_after_stop");
    },
  },
  {
    // T7 PR 19 review F7: Edit, save, and Edit again: a fresh form from the new revision,
    // with no notice left over; the saved confirmation is said beside the card.
    name: "edit_plan_reopen",
    path: `/w/${ws}/ask/conv-sample`,
    scenario: "projects_preview",
    run: async (page) => {
      await tabTo(page, (a) => a.text === "Edit", 120);
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Change the plan" });
      await dialog.waitFor();
      await dialog.getByLabel("Project name").fill("Linen Shirt on AI answers");
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await dialog.waitFor({ state: "hidden" });
      await page
        .getByRole("status")
        .filter({ hasText: "Plan changed. Look it over, then start it." })
        .waitFor();
      expect((await active(page)).text === "Edit", "edit_focus_restore");
      await page.getByRole("heading", { name: "Linen Shirt on AI answers" }).waitFor();
      await page.keyboard.press("Enter");
      await dialog.waitFor();
      const name = await dialog.getByLabel("Project name").inputValue();
      expect(name === "Linen Shirt on AI answers", "edit_not_reseeded");
      expect(
        (await dialog.getByText("Plan changed. Look it over, then start it.").count()) === 0,
        "edit_old_notice",
      );
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
    // ADR-0032 Home preview: Dismiss moves focus to the next idea's Dismiss, then to the
    // Ideas heading once none are left; focus never drops to the page body.
    name: "dismiss_ideas",
    path: `/w/${ws}`,
    scenario: "home_preview",
    run: async (page) => {
      await page.getByRole("button", { name: "Dismiss the idea from Listings" }).focus();
      await page.keyboard.press("Enter");
      expect((await active(page)).text === "Dismiss the idea from Business Analyst", "next_idea");
      await page.keyboard.press("Enter");
      expect((await active(page)).text === "Dismiss the idea from Inventory", "last_idea");
      await page.keyboard.press("Enter");
      expect((await active(page)).id === "home-ideas-title", "heading_when_none_left");
      const indicator = await page.evaluate(() => window.__morrowUi.focusIndicator());
      expect(indicator.ok, "focus_indicator:" + indicator.reason);
      await page.getByText("No more ideas for now.").waitFor();
    },
  },
  {
    name: "answer_question",
    path: `/w/${ws}/inbox/questions/q-source`,
    run: async (page) => {
      // The shell's Inbox counts (sidebar and top bar) follow the answer without a reload.
      const counts = (n) =>
        Promise.all(
          ['nav[aria-label="Main"]', "header.topbar"].map((at) =>
            page
              .locator(`${at} a[href="/w/${ws}/inbox"] .count-pill`, {
                hasText: new RegExp(`^${n}$`),
              })
              .waitFor({ state: "attached" }),
          ),
        );
      await counts(2);
      await tabTo(page, (a) => a.tag === "TEXTAREA");
      await page.keyboard.type("Cite the supplier certificate.");
      await tabTo(page, (a) => a.text === "Send answer");
      await page.keyboard.press("Enter");
      await page.getByText("Answer sent.").waitFor();
      await page.getByText("Cite the supplier certificate.").waitFor();
      await counts(1);
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
      await homeShown(page).waitFor();
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
    // PR-2 account landing: Up and Down move between workspace rows; Enter opens one.
    name: "account_chooser",
    path: "/",
    scenario: "account_chooser",
    run: async (page) => {
      await tabTo(page, (a) => a.tag === "A" && a.text.includes("Sample workspace 1"));
      await page.keyboard.press("ArrowDown");
      expect((await active(page)).text.includes("Sample workspace 2"), "arrow_down");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      expect((await active(page)).text.includes("Sample workspace 3"), "stays_on_last");
      await page.keyboard.press("ArrowUp");
      expect((await active(page)).text.includes("Sample workspace 2"), "arrow_up");
      await page.keyboard.press("Enter");
      await page.waitForURL("**/w/ws-sample-2");
    },
  },
  {
    // AC25: a 429 holds Create organization for Retry-After (2 s here); then it creates.
    name: "signup_rate_limited",
    path: "/",
    scenario: "account_rate_limited_brief",
    run: async (page) => {
      await tabTo(page, (a) => a.tag === "INPUT");
      await page.keyboard.type("Linen and Form Ltd");
      await page.keyboard.press("Tab");
      await page.keyboard.type("Main");
      await tabTo(page, (a) => a.text === "Create organization");
      await page.keyboard.press("Enter");
      await page.getByText("Too many attempts. Nothing was created.").waitFor();
      const create = page.getByRole("button", { name: "Create organization" });
      expect(await create.isDisabled(), "held");
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("button")].some(
            (b) => b.textContent === "Create organization" && !b.disabled,
          ),
        null,
        { timeout: 10000 },
      );
      expect((await page.getByText("Too many attempts").count()) === 0, "stale_copy_cleared");
      await create.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/w/${ws}`);
    },
  },
  {
    // AC25: an unknown signup outcome keeps the form filled and disabled; Check again
    // resends the same key, and the replay opens the workspace once.
    name: "signup_uncertain",
    path: "/",
    scenario: "account_uncertain",
    run: async (page) => {
      await tabTo(page, (a) => a.tag === "INPUT");
      await page.keyboard.type("Linen and Form Ltd");
      await page.keyboard.press("Tab");
      await page.keyboard.type("Main");
      await tabTo(page, (a) => a.text === "Create organization");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Check again" }).waitFor();
      expect(await page.getByLabel("Organization name").isDisabled(), "form_disabled");
      expect(
        (await page.getByLabel("Organization name").inputValue()) === "Linen and Form Ltd",
        "form_kept",
      );
      await page.getByRole("button", { name: "Check again" }).focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/w/${ws}`);
      await homeShown(page).waitFor();
    },
  },
  {
    // P05.T01ab: after the guard's 403 challenge_failed, Try again sends with a fresh
    // token (the fixture widget gives one per reset and the fixture guard refuses a
    // spent one), and the organization is created.
    name: "signup_challenge_retry",
    path: "/",
    scenario: "account_challenge_failed",
    run: async (page) => {
      await tabTo(page, (a) => a.tag === "INPUT");
      await page.keyboard.type("Linen and Form Ltd");
      await page.keyboard.press("Tab");
      await page.keyboard.type("Main");
      await tabTo(page, (a) => a.text === "Create organization");
      await page.keyboard.press("Enter");
      await page.getByText("Couldn't save. Nothing was changed.").waitFor();
      await page.getByRole("button", { name: "Try again" }).focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/w/${ws}`);
      await homeShown(page).waitFor();
    },
  },
  {
    // The account landing's Sign out (no identity is shown: no "You").
    name: "account_sign_out",
    path: "/",
    scenario: "account_invite",
    run: async (page) => {
      await tabTo(page, (a) => a.text === "Sign out");
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "You're signed out" }).waitFor();
      expect((await morrowKeys(page)).length === 0, "storage_cleared");
    },
  },
  {
    // A Check again whose replay lands after Cancel still confirms the task under its own
    // goal; the dialog, reopened on another goal meanwhile, keeps its draft.
    name: "task_reply_after_cancel",
    path: `/w/${ws}/work`,
    scenario: "uncertain_late",
    run: async (page) => {
      await page.getByRole("button", { name: "Create task" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Objective").fill("Check the size chart");
      await dialog.getByRole("button", { name: "Create task" }).click();
      await dialog.getByRole("button", { name: "Check again" }).click();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Create task" }).nth(1).click();
      await dialog.getByLabel("Objective").fill("Draft kept");
      await page.getByText("Task created.").waitFor({ timeout: 5000 });
      expect(await dialog.isVisible(), "reopened_dialog_kept");
      expect((await dialog.getByLabel("Objective").inputValue()) === "Draft kept", "draft_kept");
      expect(
        await dialog.getByText("Publish clear care instructions for every linen item").isVisible(),
        "other_goal",
      );
      await dialog.getByRole("button", { name: "Cancel" }).focus();
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("link", { name: "Check the size chart" }).waitFor();
      const tasks = page.locator("li.goal").first();
      expect(
        (await tasks.getByRole("link", { name: "Check the size chart" }).count()) === 1,
        "listed_under_its_goal",
      );
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
        (a) =>
          a.tag === "A" && a.text.length > 0 && !["Projects", "Home", "Inbox"].includes(a.text),
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
        await homeShown(page).waitFor();
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
      await homeShown(page).waitFor();
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
      expect(await homeShown(page).isVisible(), "kept_dom");
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
    // M2 PR-2: the link step by keyboard: Link store, then the lost reply's Check again
    // (status with the same key) confirms the link.
    name: "connections_link",
    path: `/w/${ws}/connections#handoff=Hx${"1".repeat(40)}A`,
    scenario: "connections_link_uncertain",
    run: async (page) => {
      await page.getByRole("button", { name: "Link store" }).waitFor();
      await tabTo(page, (a) => a.text === "Link store");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Check again" }).waitFor();
      await tabTo(page, (a) => a.text === "Check again");
      await page.keyboard.press("Enter");
      await page.getByText("Store linked.").first().waitFor();
      expect(new URL(page.url()).hash === "", "fragment_replaced");
      expect(
        (await morrowKeys(page)).every((k) => k !== "morrow.intended.v1"),
        "no_intended",
      );
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
    ({ note, targetFloors }) => {
      window.__csp = [];
      window.__provisional = note;
      window.__floors = targetFloors;
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
    { note: provisional, targetFloors: floors },
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
    // A fragment (M2 PR-2's install continuation) follows the query.
    const [pathOnly, fragment] = item.path.split("#");
    await page.goto(origin + pathOnly + query + (fragment ? "#" + fragment : ""), {
      waitUntil: "load",
    });
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
