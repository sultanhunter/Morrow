// P14.T01a browser journey lab (AC20-AC32): a real Chromium against the P04.T02a
// configured harness (the real wrangler dry-run api and broker bundles in Miniflare,
// isolated PostgreSQL 17 over the WSS->TCP bridge, the synthetic WorkOS oracle). The api
// gets an HTTPS listener on 127.0.0.1:<ephemeral> with a lab-generated certificate, and
// serves the production dist through Static Assets. PR-1 (AC20): the browser signs in
// through the SPA, enters the workspace through bootstrap and signs out. PR-2 (AC22-AC32,
// scripts/workspace-ui-journey-work.mjs): the engine also applies 0014-0015 and logs in
// the api Worker's work login, and three people work through the account and work
// routes. Every request other than the lab origin and the intercepted WorkOS authorize
// navigation is aborted and counted: zero egress. No trace, HAR, video or screenshot is
// recorded.
//   node scripts/workspace-ui-journey-lab.mjs           Linux CI (`ui` job) only
//   node scripts/workspace-ui-journey-lab.mjs --local   a developer Mac with Docker
//                                                        (supporting evidence only)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { artifactPath, writeArtifact } from "./artifacts.mjs";
import { edgeRefusals } from "./edge.mjs";
import { edgePostgresqlJourneys, edgePostgresqlRoles } from "./edge-postgresql-lab.mjs";
import {
  labChallengeActions,
  turnstileScriptUrl as turnstileScript,
  turnstileStub,
} from "./fixtures/turnstile-siteverify.mjs";
import { accountAndWorkJourneys } from "./workspace-ui-journey-work.mjs";

const held = (code) => Error("WORKSPACE_UI_JOURNEY_" + code);
const require = (condition, code) => {
  if (!condition) throw held(code);
};
const workosAuthorize = "https://api.workos.com/user_management/authorize";
// P05.T01ab: the one Turnstile URL the SPA loads is fulfilled with a stub
// `window.turnstile` (scripts/fixtures/turnstile-siteverify.mjs) that hands out tokens
// the lab issued to its synthetic siteverify, one per execute, in order.

const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

// A throwaway self-signed certificate for 127.0.0.1, made for this run only; the private
// key never leaves memory after this function and is a private marker of the report.
function labCertificate() {
  const dir = mkdtempSync(join(tmpdir(), "morrow-ui-journey-tls-"));
  try {
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    require(!result.error && result.status === 0, "CERTIFICATE");
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function workspaceUiJourney(engine, createService) {
  const port = await freePort();
  const origin = `https://127.0.0.1:${port}`;
  const tls = labCertificate();
  const observed = { aborted: 0, authorize: 0, turnstileScript: 0, posts: [] };
  const result = await edgePostgresqlJourneys(engine, createService, {
    origin,
    listen: { host: "127.0.0.1", port, httpsKey: tls.key, httpsCert: tls.cert },
    work: true,
    journeys: async (h) => {
      h.secret(tls.key);
      await h.scenario("AC20_real_browser_sign_in_bootstrap_sign_out", async () => {
        const owner = await h.instance();
        const browser = await chromium.launch({ headless: true });
        // ignoreHTTPSErrors is for the lab certificate, in this lab only.
        const context = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width: 1440, height: 900 },
          serviceWorkers: "block",
        });
        try {
          // Lab-origin requests are not intercepted at all: they take the real network
          // stack, and their recorded headers include what Chromium actually sent
          // (Origin, Sec-Fetch-*). Everything else is routed here.
          await context.route(
            (url) => url.origin !== origin,
            async (route) => {
              const url = new URL(route.request().url());
              if (
                url.origin + url.pathname === workosAuthorize &&
                route.request().isNavigationRequest()
              ) {
                observed.authorize++;
                const armed = h.oracle.arm(route.request().url());
                h.secret(armed.code, armed.token, route.request().url());
                return route.fulfill({
                  status: 302,
                  headers: { location: armed.callbackUrl, "cache-control": "no-store" },
                });
              }
              observed.aborted++;
              return route.abort();
            },
          );
          // Registered after the abort-all route, so Playwright tries it first: the
          // allowlisted Turnstile script is fulfilled by the stub and never aborted.
          const stubTokens = [1, 2, 3, 4].map(() => h.siteverify.issue(labChallengeActions.login));
          h.secret(...stubTokens);
          await context.route(
            (url) => url.href === turnstileScript,
            (route) => {
              observed.turnstileScript++;
              return route.fulfill({
                status: 200,
                contentType: "text/javascript; charset=utf-8",
                body: turnstileStub({ [labChallengeActions.login]: stubTokens }),
              });
            },
          );
          const page = await context.newPage();
          // The headers Chromium's network stack actually sent (Network ExtraInfo):
          // only the names and the Origin and Sec-Fetch-Mode values are kept.
          const sent = new Map();
          const urls = new Map();
          const cdp = await context.newCDPSession(page);
          await cdp.send("Network.enable");
          cdp.on("Network.requestWillBeSent", (event) =>
            urls.set(event.requestId, event.request.url),
          );
          cdp.on("Network.requestWillBeSentExtraInfo", (event) => {
            const lower = Object.fromEntries(
              Object.entries(event.headers).map(([name, value]) => [name.toLowerCase(), value]),
            );
            sent.set(event.requestId, {
              names: Object.keys(lower).sort(),
              origin: lower.origin ?? null,
              mode: lower["sec-fetch-mode"] ?? null,
              site: lower["sec-fetch-site"] ?? null,
            });
          });
          const sentFor = (path) =>
            [...sent.entries()]
              .filter(([id]) => urls.get(id) === origin + path)
              .map(([, headers]) => headers);
          page.on("request", (request) => {
            if (request.method() === "POST") observed.posts.push(new URL(request.url()).pathname);
          });
          const workspacePath = `/w/${h.f.workspace}`;
          const bootstrapUrl = `${origin}/workspace/${h.f.workspace}/bootstrap`;
          const firstBootstrap = page.waitForResponse((r) => r.url() === bootstrapUrl);
          await page.goto(origin + workspacePath);
          h.check("AC20:first_bootstrap_401", (await firstBootstrap).status() === 401);
          const signIn = page.getByRole("button", { name: "Sign in" });
          await signIn.waitFor({ timeout: 15000 });
          h.check(
            "AC20:provisional_label",
            (await page.getByRole("note").textContent()) ===
              "Provisional workspace · design under review",
          );
          h.check(
            "AC04:intended_route_stored",
            (await page.evaluate(() => sessionStorage.getItem("morrow.intended.v1"))) ===
              workspacePath,
          );
          const loginResponse = page.waitForResponse((r) => r.url() === `${origin}/auth/login`);
          const enteredBootstrap = page.waitForResponse(
            (r) => r.url() === bootstrapUrl && r.status() === 200,
            {
              timeout: 30000,
            },
          );
          await signIn.click();
          const login = await loginResponse;
          const loginHeaders = await login.request().allHeaders();
          h.check("AC20:login_200", login.status() === 200);
          const loginSent = sentFor("/auth/login");
          h.check(
            "AC20:login_origin_and_cors",
            loginSent.length === 1 &&
              loginSent[0].origin === origin &&
              loginSent[0].mode === "cors" &&
              loginSent[0].site === "same-origin" &&
              loginHeaders["x-morrow-request"] === "1" &&
              loginHeaders["content-type"] === "application/json" &&
              !loginSent[0].names.includes("idempotency-key") &&
              !loginSent[0].names.includes("authorization"),
          );
          // P05.T01ab-AC08: the start carried the stub's first token, read the
          // configuration once, loaded the allowlisted script once and was verified once.
          h.check(
            "P05T01ab-AC08:start_carries_a_fresh_token",
            loginSent[0].names.includes("x-morrow-challenge") &&
              loginHeaders["x-morrow-challenge"] === stubTokens[0] &&
              h.siteverify.requests.length === 1 &&
              h.siteverify.requests[0].secretMatches,
          );
          h.check(
            "P05T01ab-AC08:configuration_read_and_script_stubbed_once",
            sentFor("/auth/challenge").length === 1 && observed.turnstileScript === 1,
          );
          const entered = await enteredBootstrap;
          const view = await entered.json();
          await page
            .getByRole("heading", { name: view.workspace.displayName })
            .waitFor({ timeout: 15000 });
          h.check("AC20:bootstrap_shows_name", view.workspace.id === h.f.workspace);
          h.check("AC20:intended_route_restored", new URL(page.url()).pathname === workspacePath);
          h.check(
            "AC04:intended_route_consumed",
            (await page.evaluate(() => sessionStorage.getItem("morrow.intended.v1"))) === null,
          );
          const cookies = await context.cookies(origin);
          for (const cookie of cookies) h.secret(cookie.value);
          const session = cookies.find((c) => c.name === "__Host-morrow_session");
          require(session, "NO_SESSION_COOKIE");
          const logoutResponse = page.waitForResponse((r) => r.url() === `${origin}/auth/logout`);
          await page.getByRole("button", { name: "Sign out" }).click();
          const logout = await logoutResponse;
          h.check("AC20:logout_200", logout.status() === 200);
          const logoutSent = sentFor("/auth/logout");
          h.check(
            "AC20:logout_origin_and_cors",
            logoutSent.length === 1 &&
              logoutSent[0].origin === origin &&
              logoutSent[0].mode === "cors" &&
              logoutSent[0].site === "same-origin" &&
              !logoutSent[0].names.includes("idempotency-key"),
          );
          await page
            .getByRole("heading", { name: "You're signed out" })
            .waitFor({ timeout: 15000 });
          h.check(
            "AC07:no_morrow_storage_after_sign_out",
            (await page.evaluate(
              () => Object.keys(sessionStorage).filter((k) => k.startsWith("morrow.")).length,
            )) === 0,
          );
          h.check(
            "AC07:no_workspace_name_after_sign_out",
            !(await page.content()).includes(view.workspace.displayName),
          );
          const stale = await h.bootstrap(owner, `__Host-morrow_session=${session.value}`);
          h.check("AC20:old_cookie_401_after_sign_out", stale.status === 401);
          h.check(
            "AC20:posts_are_login_and_logout_only",
            JSON.stringify(observed.posts) === JSON.stringify(["/auth/login", "/auth/logout"]),
          );
        } finally {
          await context.close();
          await browser.close();
          await owner.dispose();
        }
        h.check("AC20:authorize_intercepted_once", observed.authorize === 1);
        h.check("AC20:zero_aborted_requests", observed.aborted === 0);
        h.check("AC20:zero_unexpected_outbound", h.outbound.unexpected === 0);
      });
      // PR-2: the account and work journeys on a fresh instance and browser.
      const browser = await chromium.launch({ headless: true });
      try {
        await accountAndWorkJourneys(h, { browser, observed });
      } finally {
        await browser.close();
      }
      h.check("AC22_AC32:zero_aborted_requests", observed.aborted === 0);
      h.check("AC22_AC32:zero_unexpected_outbound", h.outbound.unexpected === 0);
    },
  });
  return result;
}
// The engine logs in the seven edge roles plus the api Worker's work login (P06.T01a).
const uiEngineRoles = Object.freeze([...edgePostgresqlRoles, "morrow_api_worker"]);

// AC21: no trace, HAR or video exists; no planted marker reaches the ui artifacts.
function artifactHygiene(markers) {
  const dir = artifactPath("ui");
  const findings = [];
  const walk = (path) => {
    let entries = [];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        if (/\.(har|zip|webm|trace)$/i.test(entry.name)) findings.push("RECORDING:" + entry.name);
        if (statSync(file).size < 8 << 20) {
          const text = readFileSync(file, "utf8");
          if (markers.some((m) => m && text.includes(m))) findings.push("MARKER:" + entry.name);
        }
      }
    }
  };
  walk(dir);
  return findings;
}

async function main() {
  const local = process.argv.includes("--local");
  require(process.version === "v24.13.0", "PINNED_NODE");
  require(edgeRefusals().length === 0, "REFUSED");
  if (local) require(process.env.GITHUB_ACTIONS !== "true", "CI_USES_LAB_WORKSPACE_UI_JOURNEY");
  let result = null;
  let failure = null;
  const started = Date.now();
  try {
    if (local) {
      const { localEngine } = await import("./edge-postgresql-local.mjs");
      const { createSyntheticLoopbackControlledNeonTcpService } = await import(
        "./fixtures/controlled-neon-tcp-bridge.mjs"
      );
      result = (
        await localEngine(
          (engine) => workspaceUiJourney(engine, createSyntheticLoopbackControlledNeonTcpService),
          { roles: uiEngineRoles },
        )
      ).result;
    } else {
      const { managedWorkspaceWorkPostgresqlLab } = await import(
        "./fixtures/controlled-neon-postgresql.mjs"
      );
      const { createControlledNeonTcpService } = await import(
        "./fixtures/controlled-neon-tcp-bridge.mjs"
      );
      result = (
        await managedWorkspaceWorkPostgresqlLab((engine) =>
          workspaceUiJourney(engine, createControlledNeonTcpService),
        )
      ).result;
    }
  } catch (error) {
    failure = { code: String(error?.message ?? "WORKSPACE_UI_JOURNEY_HELD").slice(0, 120) };
  }
  const passed =
    !failure &&
    result &&
    result.checks.every((row) => row.passed) &&
    result.cases.every((row) => row.passed);
  const markers = result?.privateMarkers ?? [];
  const report = {
    generated_at: new Date().toISOString(),
    packet: "P14.T01a",
    status: passed ? "passed" : "held",
    scope: local
      ? "Local-only supporting run (Docker Desktop engine, loopback-published port). Not CI evidence: the hosted `ui` job is the authority."
      : "Real Chromium (Playwright) against the real wrangler dry-run api and broker bundles in local workerd, with the production SPA on Static Assets, isolated PostgreSQL 17 (migrations 0001-0015, owner-SQL work grants) and synthetic WorkOS; zero egress. Not hosted Cloudflare, Neon or WorkOS qualification.",
    platform: process.platform,
    durationMs: Date.now() - started,
    appliedMigrations: result?.appliedMigrations ?? null,
    cases: result?.cases ?? [],
    checks: result?.checks ?? [],
    outbound: result?.outbound ?? null,
    finalNamespace: result?.final ?? null,
    recordings: { trace: false, har: false, video: false, screenshots: false },
    failure,
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  require(markers.every((marker) => !marker || !text.includes(marker)), "MARKER_IN_REPORT");
  const path = writeArtifact(local ? "ui/journey-local.json" : "ui/journey.json", text);
  const hygiene = artifactHygiene(markers);
  if (hygiene.length) {
    console.error("ARTIFACT_HYGIENE: " + hygiene.join(", "));
    process.exitCode = 1;
  }
  process.stdout.write(
    JSON.stringify({
      report: path,
      status: report.status,
      cases: report.cases.length,
      checks: report.checks.length,
    }) + "\n",
  );
  if (!passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
