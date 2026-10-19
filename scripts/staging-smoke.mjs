// The staging smokes (P04.T01i D7) and the health probe the deploy and the kill share.
// Every request goes through `ctx.fetch` (tests pass a fake), with no redirects and a
// bounded body. The report holds status codes, booleans and fixed codes only: never a
// body, a header value, a cookie or an address.
//   unattended  after every deploy: health, the SPA and its CSP, routing (recorded),
//               the guard (PR-C), the database path, and the other Workers' hostnames
//   --assisted  the owner signs in in a headed browser (E8); a skeleton until PR-C
//               (AC12a) and P14.T01a PR-2 (AC12) exist
import { randomBytes } from "node:crypto";
import { StagingError } from "./staging-common.mjs";

const bodyLimit = 65536;
const requestTimeoutMs = 10000;

// Reads at most `limit` bytes of a body and discards the rest.
export async function readBounded(response, limit = bodyLimit) {
  try {
    const reader = response?.body?.getReader?.();
    if (!reader) return String((await response?.text?.()) ?? "").slice(0, limit);
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) {
        chunks.push(value.subarray(0, limit - size));
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  } catch {
    return "";
  }
}

// One request: {status, headers, text} or {status: null} when unreachable.
export async function httpProbe(ctx, url, { method = "GET", headers = {}, body } = {}) {
  let response;
  try {
    response = await ctx.fetch(url, {
      method,
      redirect: "manual",
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    return { status: null, headers: new Headers(), text: "" };
  }
  const text = await readBounded(response);
  return {
    status: Number.isSafeInteger(response.status) ? response.status : null,
    headers: response.headers ?? new Headers(),
    text,
  };
}
const jsonOf = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// The api's /healthz: "ready", "not_ready" (the api answers but is not ready), or
// "not_serving" (anything that is not the api's own reply, including unreachable).
export async function probeHealth(ctx, origin) {
  const reply = await httpProbe(ctx, origin + "/healthz", {
    headers: { Accept: "application/json" },
  });
  if (reply.status !== 200) return "not_serving";
  const body = jsonOf(reply.text);
  if (body?.schemaVersion !== 1 || body?.service !== "api") return "not_serving";
  return body.ready === true ? "ready" : "not_ready";
}
export const serving = (state) => state === "ready" || state === "not_ready";

// Polls /healthz until ready, within `timeoutMs` (D2: 90 s).
export async function waitReady(ctx, origin, { timeoutMs = 90000, intervalMs = 5000 } = {}) {
  const started = ctx.now();
  let polls = 0;
  for (;;) {
    const state = await probeHealth(ctx, origin);
    polls++;
    if (state === "ready")
      return { ready: true, last: state, polls, waitedMs: ctx.now() - started };
    if (ctx.now() - started + intervalMs > timeoutMs)
      return { ready: false, last: state, polls, waitedMs: ctx.now() - started };
    await ctx.sleep(intervalMs);
  }
}

// The hostnames of staging: the api's origin, and the workers.dev hostnames the other
// three Workers would have if workers.dev were on (they must serve nothing of theirs).
export function stagingHostnames(staging) {
  const cloudflare = staging?.cloudflare ?? {};
  const subdomain = cloudflare.workers_dev_subdomain;
  const workers = cloudflare.workers ?? {};
  if (
    typeof cloudflare.origin !== "string" ||
    typeof subdomain !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain)
  )
    throw new StagingError("STAGING_IDENTIFIERS_UNSET");
  const host = (name) => `https://${name}.${subdomain}.workers.dev`;
  if (cloudflare.origin !== host(workers.api)) throw new StagingError("STAGING_ORIGIN_MISMATCH");
  return Object.freeze({
    origin: cloudflare.origin,
    others: Object.freeze({
      broker: host(workers.broker),
      orchestrator: host(workers.orchestrator),
      connector: host(workers.connector),
    }),
  });
}

// A well-formed, random browser session secret (43 base64url characters, canonical).
export const randomSessionSecret = () => randomBytes(32).toString("base64url");

// The unattended smoke (D7 steps 1–6; step 7 with `acceptance`). Returns the checks and
// the failure codes; it creates no login flow: the login start runs only after
// /auth/challenge shows the P05.T01ab guard.
export async function unattendedSmoke(ctx, { staging, csp, acceptance = false }) {
  const { origin, others } = stagingHostnames(staging);
  const failures = [];
  const checks = {};
  const fail = (code) => failures.push(code);
  // (1) Health.
  checks.health = await probeHealth(ctx, origin);
  if (checks.health !== "ready") fail("SMOKE_HEALTH_NOT_READY");
  // (2) The SPA with the committed CSP.
  const spa = await httpProbe(ctx, origin + "/", { headers: { Accept: "text/html" } });
  checks.spa = {
    status: spa.status,
    csp: spa.headers.get("content-security-policy") === csp,
  };
  if (spa.status !== 200 || !checks.spa.csp) fail("SMOKE_SPA");
  // (3) Routing (M-R1, recorded only), and the Worker's own 404 under /api.
  const navigate = await httpProbe(ctx, origin + "/w/x/inbox", {
    headers: {
      Accept: "text/html",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Site": "none",
    },
  });
  const plain = await httpProbe(ctx, origin + "/w/x/inbox", { headers: { Accept: "*/*" } });
  const api404 = await httpProbe(ctx, origin + "/api/x", { headers: { Accept: "*/*" } });
  checks.routing = {
    navigate: navigate.status,
    plain: plain.status,
    apiStatus: api404.status,
    apiJson: /^application\/json\b/.test(api404.headers.get("content-type") ?? ""),
  };
  if (api404.status !== 404 || !checks.routing.apiJson) fail("SMOKE_API_404");
  // (4) The guard: the configuration route first, then a start without a token.
  const challenge = await httpProbe(ctx, origin + "/auth/challenge", {
    headers: { Accept: "application/json" },
  });
  const configuration = challenge.status === 200 ? jsonOf(challenge.text) : null;
  checks.guard = { configured: configuration?.provider === "turnstile", start: null };
  if (!checks.guard.configured) fail("SMOKE_GUARD_ABSENT");
  else {
    const start = await httpProbe(ctx, origin + "/auth/login", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Morrow-Request": "1",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      },
      body: JSON.stringify({ schemaVersion: 2 }),
    });
    const outcome = jsonOf(start.text)?.outcome;
    checks.guard.start = start.status;
    if (start.status !== 403 || outcome !== "challenge_required") fail("SMOKE_GUARD_FAILED");
  }
  // (5) The database path: a well-formed unknown session is 401, not 503.
  const list = await httpProbe(ctx, origin + "/workspaces", {
    headers: {
      Accept: "application/json",
      "X-Morrow-Request": "1",
      Cookie: "__Host-morrow_session=" + randomSessionSecret(),
    },
  });
  checks.databasePath = list.status;
  if (list.status !== 401) fail("SMOKE_DATABASE_PATH");
  // (6) The other three Workers' workers.dev hostnames serve nothing of theirs.
  checks.others = {};
  for (const [key, url] of Object.entries(others)) {
    const reply = await httpProbe(ctx, url + "/", { headers: { Accept: "*/*" } });
    checks.others[key] = reply.status;
    if (reply.status !== null && reply.status !== 404)
      fail("SMOKE_WORKERS_DEV_EXPOSED_" + key.toUpperCase());
  }
  // (7) Acceptance only: 11 bogus starts in 60 s produce at least one 429.
  if (acceptance) {
    if (!checks.guard.configured) checks.limiter = null;
    else {
      const statuses = [];
      for (let i = 0; i < 11; i++) {
        const reply = await httpProbe(ctx, origin + "/auth/login", {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "X-Morrow-Request": "1",
            "X-Morrow-Challenge": "MORROWSMOKE" + randomBytes(16).toString("hex"),
          },
          body: JSON.stringify({ schemaVersion: 2 }),
        });
        statuses.push(reply.status);
      }
      checks.limiter = { limited: statuses.filter((s) => s === 429).length, sent: statuses.length };
      if (checks.limiter.limited < 1) fail("SMOKE_LIMITER_ABSENT");
    }
  }
  return { origin, checks, failures };
}

// ---------------------------------------------------------------------------
// The assisted smoke (D7, card E8): a skeleton. The owner signs in in a headed Chromium
// with a fresh temporary profile and no stored password; tracing, video, screenshots and
// HAR stay off. The script records the attributes of the two __Host- cookies from their
// Set-Cookie headers and drops the values. Sign-up, bootstrap and the AC12 journey wait
// for P14.T01a PR-2; the challenge widget waits for PR-C.

// The attributes of one Set-Cookie header, never its value.
export function cookieAttributes(header) {
  if (typeof header !== "string" || header.length > 4096) return null;
  const [pair, ...parts] = header.split(";").map((part) => part.trim());
  const name = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=/.exec(pair ?? "")?.[1];
  if (name !== "__Host-morrow_login" && name !== "__Host-morrow_session") return null;
  const attributes = {
    name,
    path: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    domain: false,
    maxAge: null,
  };
  for (const part of parts) {
    const [key, ...rest] = part.split("=");
    const value = rest.join("=");
    switch (key.toLowerCase()) {
      case "path":
        attributes.path = value === "/" ? "/" : "other";
        break;
      case "secure":
        attributes.secure = true;
        break;
      case "httponly":
        attributes.httpOnly = true;
        break;
      case "samesite":
        attributes.sameSite = ["Lax", "Strict", "None"].includes(value) ? value : "other";
        break;
      case "domain":
        attributes.domain = true;
        break;
      case "max-age":
        attributes.maxAge = /^-?[0-9]{1,9}$/.test(value) ? Number(value) : null;
        break;
      default:
        break;
    }
  }
  return attributes;
}
// D7: Path=/, Secure, HttpOnly, SameSite=Lax, no Domain, and a Max-Age in range (zero
// clears a cookie at the callback or at sign-out).
export const cookieAttributesOk = (a) =>
  a !== null &&
  a.path === "/" &&
  a.secure &&
  a.httpOnly &&
  a.sameSite === "Lax" &&
  !a.domain &&
  Number.isSafeInteger(a.maxAge) &&
  a.maxAge >= 0 &&
  a.maxAge <= 2592000;

// The browser seam: `ctx.browser()` returns {launch(options)} (Playwright's chromium in
// the real context). Options are fixed here so a test can see them.
export const assistedLaunchOptions = Object.freeze({ headless: false });
export const assistedContextOptions = Object.freeze({
  acceptDownloads: false,
  serviceWorkers: "block",
});

export async function assistedSmoke(ctx, { staging, timeoutMs = 600000, pollMs = 2000 }) {
  if (!ctx.interactive()) throw new StagingError("STAGING_ASSISTED_NEEDS_TERMINAL");
  const { origin } = stagingHostnames(staging);
  const chromium = await ctx.browser();
  const browser = await chromium.launch({ ...assistedLaunchOptions });
  const cookies = [];
  const result = {
    origin,
    signIn: "pending",
    cookies,
    list: null,
    signOut: null,
    oldCookieAfterSignOut: null,
    pending: ["AC12a_challenge_widget:PR-C", "AC12_signup_and_bootstrap:P14.T01a_PR-2"],
  };
  try {
    const context = await browser.newContext({ ...assistedContextOptions });
    const page = await context.newPage();
    // Set-Cookie headers of our own origin only; attributes kept, values dropped.
    page.on("response", async (response) => {
      try {
        if (new URL(response.url()).origin !== origin) return;
        const headers = await response.headersArray();
        for (const { name, value } of headers)
          if (name.toLowerCase() === "set-cookie") {
            const attributes = cookieAttributes(value);
            if (attributes) cookies.push({ ...attributes, ok: cookieAttributesOk(attributes) });
          }
      } catch {
        // A closed page or response: nothing to record.
      }
    });
    await page.goto(origin + "/");
    ctx.notice(
      "Sign in in the browser window with your own staging test user. Claude never sees your credentials.",
    );
    const session = async () =>
      (await context.cookies(origin)).find((c) => c.name === "__Host-morrow_session") ?? null;
    const deadline = ctx.now() + timeoutMs;
    let held = null;
    while (ctx.now() < deadline) {
      const cookie = await session();
      if (cookie) {
        held = cookie.value;
        break;
      }
      await ctx.sleep(pollMs);
    }
    if (held === null) {
      result.signIn = "timed_out";
      return { ...result, exitCode: 1 };
    }
    result.signIn = "ok";
    const listed = await context.request.get(origin + "/workspaces", {
      headers: { "X-Morrow-Request": "1", Accept: "application/json" },
      maxRedirects: 0,
    });
    const listBody = jsonOf(await listed.text().catch(() => ""));
    result.list = {
      status: listed.status(),
      onboarding:
        typeof listBody?.onboarding === "string" && /^[a-z_]{1,32}$/.test(listBody.onboarding)
          ? listBody.onboarding
          : null,
    };
    ctx.notice("Now sign out in the browser window.");
    while (ctx.now() < deadline && (await session())) await ctx.sleep(pollMs);
    if (await session()) {
      result.signOut = "timed_out";
      return { ...result, exitCode: 1 };
    }
    result.signOut = "ok";
    // The old cookie, replayed once, must now be refused.
    const replay = await context.request.get(origin + "/workspaces", {
      headers: {
        "X-Morrow-Request": "1",
        Accept: "application/json",
        Cookie: "__Host-morrow_session=" + held,
      },
      maxRedirects: 0,
    });
    held = null;
    result.oldCookieAfterSignOut = replay.status();
    const ok =
      result.list.status === 200 &&
      result.oldCookieAfterSignOut === 401 &&
      cookies.length > 0 &&
      cookies.every((c) => c.ok);
    return { ...result, exitCode: ok ? 0 : 1 };
  } finally {
    await browser.close().catch(() => {});
  }
}
