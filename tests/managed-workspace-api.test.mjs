import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import defaultWorker, { createWorkspaceApiWorker } from "../apps/api/src/worker.ts";
import { snapshotManagedWorkspaceResponseMetrics } from "../packages/identity/src/managed-workspace-request.ts";
import { snapshotManagedLoginResponseMetrics } from "../packages/identity/src/managed-login-request.ts";
import { parseLoginConfiguration } from "../packages/identity/src/standalone-login-protocol.ts";
import { createStandaloneLoginFixture } from "../scripts/fixtures/standalone-login-fixture.ts";
import { buildWorkosAuthenticationEvidenceFixture } from "./fixtures/workos-authentication-evidence.mjs";

// CPU composition only: the context and denying broker below are synthetic.
// Native context provenance, accepted SQL and post-response retention are
// separately measured by the native and real PostgreSQL runners.
const native = buildWorkosAuthenticationEvidenceFixture();
const fixed = createStandaloneLoginFixture({ ...native, page: native.page() });
const cfg = await parseLoginConfiguration(fixed.configurationJson);
const auth = JSON.parse(JSON.parse(fixed.configurationJson).authenticationBindingJson);
const origin = cfg.origin,
  epoch = native.at;
const secret = Buffer.alloc(32, 27).toString("base64url");
const token = Buffer.alloc(32, 31).toString("base64url");
const command = "e519ea9d-c5eb-4613-906c-26a870c0e9e8";
const binding = {
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-workspace-api-unit",
  branchId: "br-workspace-api-unit",
  hostname: "ep-workspace-api-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const logout = {
  schemaVersion: 1,
  protocol: "morrow-self-logout-v1",
  origin,
  providerId: "workos",
  environmentId: auth.environmentId,
  applicationId: auth.applicationId,
  clientId: auth.clientId,
  profileId: cfg.profileId,
};
function fixture() {
  let at = epoch,
    clockCalls = 0;
  const borrows = [],
    providers = [],
    registered = [];
  const keyId = randomUUID();
  const f = {
    dependencies: {
      login: {
        configurationJson: fixed.configurationJson,
        capsuleKeyringJson: JSON.stringify({
          schemaVersion: 1,
          purpose: "morrow.login.capsule/1",
          configurationDigest: cfg.configurationDigest,
          currentKeyId: keyId,
          versions: [
            {
              keyId,
              material: randomBytes(32).toString("base64url"),
              encryptFromMs: epoch - 1000,
              encryptUntilMs: epoch + 600000,
              decryptUntilMs: epoch + 900000,
            },
          ],
        }),
        bindingJson: JSON.stringify(binding),
        now: () => {
          clockCalls++;
          return at;
        },
        credentialBroker: {
          async borrow(namespace, control) {
            borrows.push({
              namespace: JSON.parse(namespace),
              deadlineMs: control.deadlineMs,
              signal: control.signal,
              receiver: this,
            });
            throw Error("SYNTHETIC_NO_CREDENTIAL_NO_DIAL");
          },
        },
        providerPort: Object.fromEntries(
          ["exchange", "readPublicKeyset", "readSessionPage"].map((name) => [
            name,
            async function () {
              providers.push(name);
              throw Error("NO_PROVIDER");
            },
          ]),
        ),
      },
      workspaceConfigurationJson: JSON.stringify({ schemaVersion: 1, mode: "https", origin }),
      logoutConfigurationJson: JSON.stringify(logout),
    },
    ctx: {
      waitUntil(pending) {
        registered.push(pending);
      },
    },
    borrows,
    providers,
    registered,
    setTime(value) {
      at = value;
    },
    clockCalls: () => clockCalls,
    async drain() {
      await Promise.allSettled(registered);
    },
  };
  return f;
}
function request(route = "bootstrap", change = {}) {
  const paths = {
    bootstrap: "/workspace/workspace_a/bootstrap",
    preview: "/workspace/workspace_a/store-links/preview",
    apply: "/workspace/workspace_a/store-links",
    status: "/workspace/workspace_a/store-links/status",
    logout: "/auth/logout",
    login: "/auth/login",
  };
  const { headers = {}, path = paths[route], ...rest } = change;
  const mutation = route !== "bootstrap";
  const body =
    route === "logout"
      ? { schemaVersion: 1 }
      : route === "login"
        ? { schemaVersion: 2 }
        : { handoffToken: token };
  const csrf = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(JSON.stringify(["morrow.store-links.csrf", 1, "workspace_a", command, token]))
    .digest("base64url");
  return new Request(origin + path, {
    method: mutation ? "POST" : "GET",
    headers: {
      Cookie: `__Host-morrow_session=${secret}`,
      ...(mutation
        ? { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" }
        : {}),
      ...(["preview", "apply", "status"].includes(route) ? { "Idempotency-Key": command } : {}),
      ...(route === "apply" ? { "X-Morrow-CSRF": csrf } : {}),
      ...headers,
    },
    ...(mutation ? { body: JSON.stringify(body) } : {}),
    ...rest,
  });
}
function accountRequest(route, headers = {}) {
  const post = route === "organizations";
  return new Request(origin + "/" + route, {
    method: post ? "POST" : "GET",
    headers: {
      Cookie: `__Host-morrow_session=${secret}`,
      "X-Morrow-Request": "1",
      ...(post
        ? { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": command }
        : {}),
      ...headers,
    },
    ...(post
      ? {
          body: JSON.stringify({
            schemaVersion: 1,
            organizationName: "Noor",
            workspaceName: "Main",
          }),
        }
      : {}),
  });
}
async function run(f, worker, input) {
  const response = await worker.fetch(input, undefined, f.ctx);
  await f.drain();
  assert.equal(response.headers.has("set-cookie"), false);
  assert.deepEqual(f.providers, []);
  return response;
}
function patchDigest(t, hook) {
  const original = crypto.subtle.digest;
  let calls = 0;
  crypto.subtle.digest = function (...args) {
    const pending = Reflect.apply(original, this, args);
    return hook(++calls, pending) ?? pending;
  };
  t.after(() => {
    crypto.subtle.digest = original;
  });
  return () => calls;
}
test("ordinary default entry is unbound and denies every exposed route without context", async () => {
  const ctx = new Proxy(
    {},
    {
      get() {
        throw Error("CONTEXT_MUST_NOT_BE_READ");
      },
    },
  );
  for (const [route, expected] of [
    ["bootstrap", 401],
    ["preview", 401],
    ["logout", 503],
    ["login", 503],
  ]) {
    const response = await defaultWorker.fetch(request(route), undefined, ctx);
    assert.equal(response.status, expected);
    assert.equal(response.headers.has("set-cookie"), false);
  }
  // P05.T01x-AC38: the account routes deny with the workspace 401 when unconfigured.
  for (const input of [accountRequest("workspaces"), accountRequest("organizations")]) {
    const response = await defaultWorker.fetch(input, undefined, ctx);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { code: "authentication_required" });
    assert.equal(response.headers.has("set-cookie"), false);
  }
  assert.equal(
    (await defaultWorker.fetch(new Request(origin + "/unknown"), undefined, ctx)).status,
    404,
  );
});
test("configured constructor is synchronous, frozen and crypto/clock/broker inert", (t) => {
  const f = fixture(),
    count = patchDigest(t, () => {});
  const worker = createWorkspaceApiWorker(f.dependencies);
  assert.ok(Object.isFrozen(worker));
  assert.deepEqual(Object.keys(worker), ["fetch"]);
  assert.equal(count(), 0);
  assert.equal(f.clockCalls(), 0);
  assert.deepEqual(f.borrows, []);
  assert.deepEqual(f.providers, []);
});
test("constructor denies unknown fields and accessors without invoking them", () => {
  const f = fixture();
  assert.throws(
    () => createWorkspaceApiWorker({ ...f.dependencies, routes: {} }),
    /CONFIGURATION_INVALID/,
  );
  let invoked = false;
  Object.defineProperty(f.dependencies, "workspaceConfigurationJson", {
    get() {
      invoked = true;
      return "{}";
    },
  });
  assert.throws(() => createWorkspaceApiWorker(f.dependencies), /CONFIGURATION_INVALID/);
  assert.equal(invoked, false);
  assert.equal(f.clockCalls(), 0);
});
for (const [name, modify] of [
  [
    "workspace origin",
    (f) => {
      f.dependencies.workspaceConfigurationJson = JSON.stringify({
        schemaVersion: 1,
        mode: "https",
        origin: "https://foreign.test",
      });
    },
  ],
  [
    "logout client",
    (f) => {
      f.dependencies.logoutConfigurationJson = JSON.stringify({
        ...logout,
        clientId: "client_foreign",
      });
    },
  ],
  [
    "invalid Neon binding",
    (f) => {
      f.dependencies.login.bindingJson = JSON.stringify({ ...binding, hostname: "foreign.test" });
    },
  ],
])
  test(`cross-mismatched ${name} fails before any hash or lease`, (t) => {
    const f = fixture(),
      count = patchDigest(t, () => {});
    modify(f);
    assert.throws(() => createWorkspaceApiWorker(f.dependencies), /CONFIGURATION_INVALID/);
    assert.equal(count(), 0);
    assert.deepEqual(f.borrows, []);
  });
for (const [route, role] of [
  ["bootstrap", "morrow_api"],
  ["preview", "morrow_identity_linking"],
  ["apply", "morrow_identity_linking"],
  ["status", "morrow_identity_linking"],
  ["logout", "morrow_identity_logout"],
]) {
  test(`configured ${route} uses only its fixed role and original workspace budget`, async () => {
    const f = fixture(),
      worker = createWorkspaceApiWorker(f.dependencies);
    const response = await run(f, worker, request(route));
    assert.equal(response.status, 503);
    assert.equal(f.borrows.length, 1);
    const borrowed = f.borrows[0];
    assert.equal(borrowed.namespace.role, role);
    assert.equal(borrowed.namespace.purpose, "workspace_primary_and_one_same_role_observer");
    assert.equal(borrowed.namespace.hostname, binding.hostname);
    assert.ok(borrowed.deadlineMs <= epoch + 5000);
    const m = snapshotManagedWorkspaceResponseMetrics(response);
    assert.equal(m.enteredAtMs, epoch);
    assert.equal(m.initialDeadlineMs, epoch + 5000);
    assert.equal(m.finalDeadlineMs, m.initialDeadlineMs);
    assert.equal(m.attemptEnded, true);
    assert.match(m.configurationDigest, /^[a-f0-9]{64}$/);
    assert.notEqual(m.configurationDigest, cfg.configurationDigest);
    assert.equal(m.ownership.namespaceMismatches, 0);
    assert.equal(m.ownership.publicationAttempts, 1);
    assert.ok(Object.isFrozen(m));
    assert.deepEqual(Object.keys(m.pools).sort(), [
      "identityPool",
      "linkingPool",
      "logoutPool",
      "onboardingPool",
    ]);
  });
}
test("unchanged login delegates directly to its own request owner and original purpose", async () => {
  const f = fixture(),
    worker = createWorkspaceApiWorker(f.dependencies);
  const response = await run(f, worker, request("login", { headers: { Cookie: "" } }));
  assert.equal(response.status, 503);
  assert.equal(f.borrows.length, 1);
  assert.equal(f.borrows[0].namespace.purpose, "primary_and_one_same_role_observer");
  const m = snapshotManagedLoginResponseMetrics(response);
  assert.throws(() => snapshotManagedWorkspaceResponseMetrics(response), /HELD/);
  assert.equal(m.initialDeadlineMs, epoch + 25000);
});
test("captured configuration, methods and clock survive caller mutation", async () => {
  const f = fixture(),
    broker = f.dependencies.login.credentialBroker;
  const worker = createWorkspaceApiWorker(f.dependencies);
  f.dependencies.workspaceConfigurationJson = "{}";
  f.dependencies.logoutConfigurationJson = "{}";
  f.dependencies.login.bindingJson = "{}";
  f.dependencies.login.now = () => {
    throw Error("MUTATED_CLOCK");
  };
  broker.borrow = () => {
    throw Error("MUTATED_BROKER");
  };
  await run(f, worker, request());
  assert.equal(f.borrows.length, 1);
  assert.equal(f.borrows[0].receiver, broker);
  assert.equal(f.borrows[0].namespace.role, "morrow_api");
});
for (const [name, input, expected] of [
  ["missing bootstrap cookie", () => request("bootstrap", { headers: { Cookie: "" } }), 401],
  [
    "wrong bootstrap workspace path",
    () => request("bootstrap", { path: "/workspace/%77orkspace_a/bootstrap" }),
    404,
  ],
  [
    "foreign bootstrap origin",
    () => request("bootstrap", { headers: { Origin: "https://foreign.test" } }),
    403,
  ],
  ["wrong bootstrap method", () => request("bootstrap", { method: "POST", body: "{}" }), 405],
  [
    "missing linking marker",
    () => request("preview", { headers: { "X-Morrow-Request": "" } }),
    403,
  ],
  ["invalid apply CSRF", () => request("apply", { headers: { "X-Morrow-CSRF": "bad" } }), 403],
  ["missing logout cookie", () => request("logout", { headers: { Cookie: "" } }), 403],
  ["invalid logout body", () => request("logout", { body: "{}" }), 400],
])
  test(`${name} preserves the existing denial and makes no lease`, async () => {
    const f = fixture(),
      response = await run(f, createWorkspaceApiWorker(f.dependencies), input());
    assert.equal(response.status, expected);
    assert.deepEqual(f.borrows, []);
  });
test("unknown app paths never read request context or enter authority setup", async () => {
  const f = fixture(),
    worker = createWorkspaceApiWorker(f.dependencies);
  const response = await worker.fetch(
    new Request(origin + "/unknown"),
    undefined,
    new Proxy(
      {},
      {
        get() {
          throw Error("NO_CONTEXT");
        },
      },
    ),
  );
  assert.equal(response.status, 404);
  assert.equal(f.clockCalls(), 0);
});
test("configuration hash time consumes the original budget and forbids the next hash or lease", async (t) => {
  const f = fixture(),
    worker = createWorkspaceApiWorker(f.dependencies);
  const count = patchDigest(t, (n, pending) =>
    n === 1
      ? pending.then((value) => {
          f.setTime(epoch + 5000);
          return value;
        })
      : undefined,
  );
  const response = await run(f, worker, request());
  assert.equal(response.status, 503);
  assert.equal(count(), 1);
  assert.deepEqual(f.borrows, []);
  assert.equal(snapshotManagedWorkspaceResponseMetrics(response).initialDeadlineMs, epoch + 5000);
});
test("abort during setup receives no replacement delivery and makes no lease", async (t) => {
  const f = fixture(),
    worker = createWorkspaceApiWorker(f.dependencies),
    abort = new AbortController();
  patchDigest(t, (n, pending) =>
    n === 1
      ? pending.then((value) => {
          abort.abort();
          return value;
        })
      : undefined,
  );
  await assert.rejects(
    worker.fetch(request("bootstrap", { signal: abort.signal }), undefined, f.ctx),
    /HELD/,
  );
  await f.drain();
  assert.deepEqual(f.borrows, []);
});
test("two simultaneous requests retain separate original budgets, signals and response observations", async () => {
  const f = fixture(),
    worker = createWorkspaceApiWorker(f.dependencies);
  const responses = await Promise.all([
    worker.fetch(request(), undefined, f.ctx),
    worker.fetch(request("preview"), undefined, f.ctx),
  ]);
  await f.drain();
  assert.equal(f.borrows.length, 2);
  assert.notEqual(f.borrows[0].signal, f.borrows[1].signal);
  const [a, b] = responses.map(snapshotManagedWorkspaceResponseMetrics);
  assert.notEqual(a, b);
  assert.equal(a.configurationDigest, b.configurationDigest);
  assert.equal(a.initialDeadlineMs, epoch + 5000);
  assert.equal(b.initialDeadlineMs, epoch + 5000);
  assert.deepEqual(f.borrows.map((row) => row.namespace.role).sort(), [
    "morrow_api",
    "morrow_identity_linking",
  ]);
});
test("a backwards clock becomes sticky across workspace and logout requests", async () => {
  const f = fixture(),
    worker = createWorkspaceApiWorker(f.dependencies);
  await run(f, worker, request());
  const before = f.borrows.length;
  f.setTime(epoch - 1);
  assert.equal((await run(f, worker, request())).status, 503);
  f.setTime(epoch + 1);
  assert.equal((await run(f, worker, request("logout"))).status, 503);
  assert.equal(f.borrows.length, before);
});
for (const [route, role] of [
  ["workspaces", "morrow_api"],
  ["organizations", "morrow_identity_onboarding"],
])
  test(`account ${route} reaches the workspace handler; a broker lease failure is unavailable`, async () => {
    const f = fixture(),
      worker = createWorkspaceApiWorker(f.dependencies);
    const response = await run(f, worker, accountRequest(route));
    // P05.T01x-AC23: a failure before the create statement is never outcome_unknown.
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "unavailable" });
    assert.equal(f.borrows.length, 1);
    assert.equal(f.borrows[0].namespace.role, role);
    assert.equal(f.borrows[0].namespace.purpose, "workspace_primary_and_one_same_role_observer");
    const m = snapshotManagedWorkspaceResponseMetrics(response);
    assert.equal(m.attemptEnded, true);
    assert.equal(m.initialDeadlineMs, epoch + 5000);
  });
test("account routes refuse their envelope before any lease (P05.T01x-AC28)", async () => {
  for (const [input, status] of [
    [accountRequest("workspaces", { "X-Morrow-Request": "0" }), 403],
    [accountRequest("organizations", { Origin: "https://evil.example" }), 403],
    [accountRequest("organizations", { "Idempotency-Key": "not-a-key" }), 400],
    [accountRequest("workspaces", { Cookie: "" }), 401],
    [new Request(origin + "/workspaces", { method: "DELETE" }), 405],
    [
      new Request(origin + "/workspaces/", {
        headers: { Cookie: `__Host-morrow_session=${secret}` },
      }),
      404,
    ],
  ]) {
    const f = fixture(),
      worker = createWorkspaceApiWorker(f.dependencies);
    const response = await worker.fetch(input, undefined, f.ctx);
    await f.drain();
    assert.equal(response.status, status, input.url + " " + input.method);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.deepEqual(f.borrows, []);
  }
});
