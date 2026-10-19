import { randomBytes } from "node:crypto";

// P05.T01ab lab fixture: a synthetic Turnstile siteverify behind the broker's fixed URL
// (labs route https://challenges.cloudflare.com to it through Miniflare's outbound
// service; nothing leaves the machine). The secret and the site key are random `0x`
// values made per run, never Cloudflare's published dummy keys, which the broker's
// `^0x` rule refuses by construction. Tokens are issued by the lab and single-use,
// like Turnstile's own (a second use answers timeout-or-duplicate).
export const siteverifyOrigin = "https://challenges.cloudflare.com";
export const siteverifyPath = "/turnstile/v0/siteverify";
export const labChallengeActions = Object.freeze({
  login: "account_login",
  signup: "organization_signup",
});

export function createSiteverifyOracle({ hostname, now = Date.now }) {
  const secret = "0x" + randomBytes(24).toString("base64url");
  const siteKey = "0x" + randomBytes(16).toString("base64url");
  const tokens = new Map();
  const requests = [];
  const state = { fault: null };
  const issue = (action, mode = "pass") => {
    const token = "lab." + randomBytes(48).toString("base64url");
    tokens.set(token, { action, mode, used: false });
    return token;
  };
  async function handleRequest(request) {
    const url = new URL(request.url);
    const text = await request.text();
    const form = new URLSearchParams(text);
    requests.push({
      method: request.method,
      path: url.pathname,
      contentType: request.headers.get("content-type"),
      fields: [...form.keys()],
      secretMatches: form.get("secret") === secret,
    });
    if (url.pathname !== siteverifyPath || request.method !== "POST")
      return new Response(null, { status: 404 });
    switch (state.fault) {
      case "status_500":
        return new Response("{}", { status: 500 });
      case "redirect":
        return new Response(null, { status: 302, headers: { location: url.href } });
      case "oversized":
        return new Response(" ".repeat(5000), { headers: { "content-type": "application/json" } });
      case "hang":
        return new Promise(() => {});
      default:
    }
    const entry = tokens.get(form.get("response") ?? "");
    const fresh = entry !== undefined && !entry.used;
    if (entry) entry.used = true;
    const success = fresh && form.get("secret") === secret && entry.mode === "pass";
    return Response.json({
      success,
      challenge_ts: new Date(entry?.mode === "stale" ? now() - 400000 : now()).toISOString(),
      hostname: entry?.mode === "other_host" ? "other.example.test" : hostname,
      "error-codes": success
        ? []
        : entry !== undefined && !fresh
          ? ["timeout-or-duplicate"]
          : ["invalid-input-response"],
      action: entry?.mode === "other_action" ? "other_action" : (entry?.action ?? ""),
      cdata: "",
    });
  }
  return {
    secret,
    siteKey,
    issue,
    requests,
    setFault: (fault) => (state.fault = fault),
    handleRequest,
    // The api's LOGIN_CHALLENGE_JSON and the broker's TURNSTILE_CONFIGURATION_JSON.
    loginChallengeJson: JSON.stringify({
      schemaVersion: 1,
      provider: "turnstile",
      siteKey,
      actions: labChallengeActions,
    }),
    turnstileConfigurationJson: JSON.stringify({
      schemaVersion: 1,
      hostname,
      actions: labChallengeActions,
    }),
  };
}
