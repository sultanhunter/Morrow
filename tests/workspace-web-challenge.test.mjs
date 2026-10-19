import test from "node:test";
import assert from "node:assert/strict";
import {
  createTurnstileChallengeHost,
  decodeChallengeConfiguration,
  turnstileScriptUrl,
} from "../apps/workspace-web/src/http/challenge.ts";
import { createClient } from "../apps/workspace-web/src/http/client.ts";
import { json, recordingTransport } from "./fixtures/workspace-web.mjs";

// P05.T01ab-AC08 (SPA half): the Turnstile host over a fake page and fake `turnstile`.
// No browser, no network; the browser half is the P14.T01a journey lab's stub.
const siteKey = "0x4AAAAAAA" + "b".repeat(20);
const actions = { login: "account_login", signup: "organization_signup" };
const configured = { schemaVersion: 1, provider: "turnstile", siteKey, actions };
const response = (status, body) => ({
  kind: "response",
  status,
  headers: new Headers(),
  body,
  json: true,
});

test("the configuration decoder accepts exactly the two documented shapes", () => {
  assert.deepEqual(decodeChallengeConfiguration(response(200, { provider: "none" })), {
    provider: "none",
  });
  assert.deepEqual(decodeChallengeConfiguration(response(200, configured)), {
    provider: "turnstile",
    siteKey,
    actions,
  });
  for (const body of [
    { provider: "none", schemaVersion: 1 },
    { ...configured, schemaVersion: 2 },
    { ...configured, provider: "recaptcha" },
    { ...configured, siteKey: "1x00000000000000000000AA" },
    { ...configured, actions: { login: "account_login" } },
    { ...configured, actions: { ...actions, extra: "x" } },
    { ...configured, actions: { login: "a b", signup: "x" } },
    { ...configured, extra: true },
    [],
    null,
  ])
    assert.equal(decodeChallengeConfiguration(response(200, body)), null, JSON.stringify(body));
  assert.equal(decodeChallengeConfiguration(response(503, configured)), null);
  assert.equal(decodeChallengeConfiguration({ kind: "lost" }), null);
});

// A fake page: `document.head.append` records scripts; `turnstile` is optional.
function fakePage(turnstile) {
  const scripts = [];
  const page = {
    turnstile,
    document: {
      createElement(tag) {
        const listeners = {};
        const element = {
          tag,
          addEventListener: (type, fn) => (listeners[type] = fn),
          fire: (type) => listeners[type]?.(),
        };
        return element;
      },
      head: { append: (element) => scripts.push(element) },
    },
  };
  return { page, scripts };
}
// A fake Turnstile that issues one token per execute and records every call.
function fakeTurnstile({ issue = (n) => "tok." + n, fail = false } = {}) {
  const calls = [];
  const widgets = new Map();
  let n = 0;
  return {
    calls,
    api: {
      render(element, options) {
        const id = "w" + (widgets.size + 1);
        widgets.set(id, options);
        calls.push(["render", element, { ...options }]);
        return id;
      },
      execute(id) {
        calls.push(["execute", id]);
        const options = widgets.get(id);
        queueMicrotask(() =>
          fail ? options["error-callback"]("300030") : options.callback(issue(++n)),
        );
      },
      reset: (id) => calls.push(["reset", id]),
      remove: (id) => calls.push(["remove", id]),
    },
  };
}
const hostFor = (reply, page, extra = {}) => {
  const recorded = recordingTransport(reply);
  const client = createClient({ transport: recorded.transport, online: () => true });
  return {
    calls: recorded.calls,
    host: createTurnstileChallengeHost({ client, window: page, ...extra }),
  };
};

test("provider none: no script, no widget, a null token", async () => {
  const { page, scripts } = fakePage(undefined);
  const { calls, host } = hostFor(() => json(200, { provider: "none" }), page);
  const widget = host("login", { id: "host" });
  assert.equal(await widget.token(), null);
  assert.equal(await widget.token(), null);
  assert.equal(scripts.length, 0);
  assert.equal(calls.length, 1, "one configuration read per page");
  assert.equal(calls[0].path, "/auth/challenge");
  assert.equal(calls[0].init.method, "GET");
});

test("turnstile: one invisible execute-mode widget; a fresh token per POST, reset after", async () => {
  const turnstile = fakeTurnstile();
  const { page, scripts } = fakePage(turnstile.api);
  const { calls, host } = hostFor(() => json(200, configured), page);
  const element = { id: "host" };
  const widget = host("login", element);
  assert.equal(await widget.token(), "tok.1");
  widget.reset();
  assert.equal(await widget.token(), "tok.2");
  widget.reset();
  const signup = host("signup", { id: "signup-host" });
  assert.equal(await signup.token(), "tok.3");
  assert.equal(scripts.length, 0, "an already loaded api.js is reused");
  assert.equal(calls.length, 1);
  const renders = turnstile.calls.filter((call) => call[0] === "render");
  assert.equal(renders.length, 2);
  assert.equal(renders[0][1], element);
  const options = renders[0][2];
  assert.equal(options.sitekey, siteKey);
  assert.equal(options.action, actions.login);
  assert.equal(options.execution, "execute");
  assert.equal(options.appearance, "interaction-only");
  assert.equal(options.retry, "never");
  assert.equal(options["refresh-expired"], "never");
  assert.equal(options["response-field"], false);
  assert.equal(renders[1][2].action, actions.signup);
  assert.deepEqual(
    turnstile.calls.filter((call) => call[0] !== "render").map((call) => call.join(":")),
    ["execute:w1", "reset:w1", "execute:w1", "reset:w1", "execute:w2"],
  );
  widget.remove();
  assert.deepEqual(turnstile.calls.at(-1), ["remove", "w1"]);
  assert.equal(await widget.token(), "failed", "a removed widget gives no token");
});

test("turnstile errors, malformed tokens and a missing api are 'failed'", async () => {
  for (const turnstile of [
    fakeTurnstile({ fail: true }),
    fakeTurnstile({ issue: () => "bad token" }),
    fakeTurnstile({ issue: () => "a".repeat(2049) }),
  ]) {
    const { page } = fakePage(turnstile.api);
    const { host } = hostFor(() => json(200, configured), page);
    assert.equal(await host("login", {}).token(), "failed");
  }
  // A timeout settles as failed.
  const silent = fakeTurnstile();
  silent.api.execute = () => {};
  const { page } = fakePage(silent.api);
  const { host } = hostFor(() => json(200, configured), page, { tokenTimeoutMs: 20 });
  assert.equal(await host("login", {}).token(), "failed");
});

test("a failed configuration read is not cached; the next attempt asks again", async () => {
  const turnstile = fakeTurnstile();
  const { page } = fakePage(turnstile.api);
  let replies = 0;
  const { calls, host } = hostFor(
    () => (++replies === 1 ? json(503, { code: "unavailable" }) : json(200, configured)),
    page,
  );
  const widget = host("login", {});
  assert.equal(await widget.token(), "failed");
  assert.equal(await widget.token(), "tok.1");
  assert.equal(calls.length, 2);
});

test("api.js loads once from exactly the allowlisted URL; a load error is retried later", async () => {
  const { page, scripts } = fakePage(undefined);
  const { host } = hostFor(() => json(200, configured), page, { scriptTimeoutMs: 1000 });
  const first = host("login", {});
  const pending = first.token();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].tag, "script");
  assert.equal(scripts[0].src, turnstileScriptUrl);
  assert.equal(
    turnstileScriptUrl,
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  );
  assert.equal(scripts[0].async, true);
  scripts[0].fire("error");
  assert.equal(await pending, "failed");
  const turnstile = fakeTurnstile();
  const second = host("login", {});
  const later = second.token();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scripts.length, 2, "a failed load is retried by the next widget");
  page.turnstile = turnstile.api;
  scripts[1].fire("load");
  assert.equal(await later, "tok.1");
});
