import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  captureManagedWorkspaceBinding,
  resolveManagedWorkspaceBinding,
} from "../packages/identity/src/managed-workspace-binding.ts";
import {
  createLoginAttempt,
  parseLoginConfiguration,
} from "../packages/identity/src/standalone-login-protocol.ts";
import {
  createStandaloneLogout,
  dispatchStandaloneLogoutWithAttempt,
  parseStandaloneLogoutConfigurationWithAttempt,
} from "../packages/identity/src/standalone-logout.ts";
import { createStandaloneLoginFixture } from "../scripts/fixtures/standalone-login-fixture.ts";
import { appliedLegacyLoginControllerProtocol } from "../scripts/fixtures/standalone-login-fixture.mjs";
import { buildWorkosAuthenticationEvidenceFixture } from "./fixtures/workos-authentication-evidence.mjs";
import {
  createStandaloneLogoutFixture,
  logoutFixtureRequest,
} from "../scripts/fixtures/standalone-logout-fixture.ts";

// CPU configuration/owner compatibility only. All successful hashes are real
// WebCrypto; synthetic SQL controls do not prove native/realSQL request lifetime.
const native = buildWorkosAuthenticationEvidenceFixture();
const fixed = createStandaloneLoginFixture({ ...native, page: native.page() });
const login = JSON.parse(fixed.configurationJson);
const auth = JSON.parse(login.authenticationBindingJson);
const configuration = await parseLoginConfiguration(fixed.configurationJson);
const sha = (v) => createHash("sha256").update(v).digest("hex");
const binding = {
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-workspace-unit",
  branchId: "br-workspace-unit",
  hostname: "ep-workspace-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const logout = {
  schemaVersion: 1,
  protocol: "morrow-self-logout-v1",
  origin: login.origin,
  providerId: "workos",
  environmentId: auth.environmentId,
  applicationId: auth.applicationId,
  clientId: auth.clientId,
  profileId: login.profileId,
};
function inputs(change = {}) {
  return {
    loginConfigurationJson: fixed.configurationJson,
    workspaceConfigurationJson: JSON.stringify({
      schemaVersion: 1,
      mode: "https",
      origin: login.origin,
    }),
    logoutConfigurationJson: JSON.stringify(logout),
    bindingJson: JSON.stringify(binding),
    ...change,
  };
}
function authority(duration = 5000) {
  let at = native.at;
  const abort = new AbortController();
  const attempt = createLoginAttempt(() => at, abort.signal, duration);
  return { attempt, abort, setTime: (value) => (at = value), now: () => at };
}
async function hashes(run, observe = () => {}) {
  const original = crypto.subtle.digest;
  let calls = 0;
  crypto.subtle.digest = function (...args) {
    const pending = Reflect.apply(original, this, args);
    return observe(++calls, pending) ?? pending;
  };
  try {
    return await run(() => calls);
  } finally {
    crypto.subtle.digest = original;
  }
}
test("synchronous captured cross-match performs no crypto and retains only frozen primitives", async () => {
  await hashes((count) => {
    const source = inputs(),
      captured = captureManagedWorkspaceBinding(source);
    source.bindingJson = "changed-after-capture";
    assert.ok(Object.isFrozen(captured));
    assert.deepEqual(Object.keys(captured).sort(), [...Object.keys(inputs()), "origin"].sort());
    assert.ok(Object.values(captured).every((v) => typeof v === "string"));
    assert.equal(captured.bindingJson, JSON.stringify(binding));
    assert.equal(captured.origin, login.origin);
    assert.equal(count(), 0);
  });
});
test("real controlled hashes preserve both old purposes and exact application transcript", async () => {
  const a = authority();
  try {
    await hashes(async (count) => {
      const resolved = await resolveManagedWorkspaceBinding(
        captureManagedWorkspaceBinding(inputs()),
        a.attempt,
      );
      const logoutDigest = sha(
        JSON.stringify([
          "morrow.browser.self_logout.configuration",
          "1",
          logout.protocol,
          logout.origin,
          "workos",
          logout.environmentId,
          logout.applicationId,
          logout.clientId,
          logout.profileId,
        ]),
      );
      assert.equal(resolved.login.configurationDigest, configuration.configurationDigest);
      assert.equal(resolved.logout.configurationDigest, logoutDigest);
      assert.equal(
        resolved.configurationDigest,
        sha(
          JSON.stringify([
            "morrow.workspace.api.configuration",
            "1",
            configuration.configurationDigest,
            logoutDigest,
            "https",
            login.origin,
            binding.environment,
            binding.projectId,
            binding.branchId,
            binding.hostname,
            binding.database,
          ]),
        ),
      );
      assert.equal(count(), 4);
      assert.ok([resolved, resolved.login, resolved.logout, resolved.neon].every(Object.isFrozen));
      assert.equal(a.attempt.control().deadlineMs, native.at + 5000);
      assert.equal(a.attempt.check(), native.at);
    });
  } finally {
    a.attempt.end();
  }
});
test("semantic workspace JSON formatting is stable and no keyring or pending cache is captured", async () => {
  const a = authority(),
    b = authority();
  try {
    const [one, two] = await Promise.all([
      resolveManagedWorkspaceBinding(captureManagedWorkspaceBinding(inputs()), a.attempt),
      resolveManagedWorkspaceBinding(
        captureManagedWorkspaceBinding(
          inputs({
            workspaceConfigurationJson: JSON.stringify(
              { origin: login.origin, mode: "https", schemaVersion: 1 },
              null,
              2,
            ),
          }),
        ),
        b.attempt,
      ),
    ]);
    assert.equal(one.configurationDigest, two.configurationDigest);
    assert.notEqual(one, two);
    assert.notEqual(one.login, two.login);
    assert.equal(
      Object.values(one).some((v) => v instanceof Promise),
      false,
    );
    assert.throws(
      () =>
        captureManagedWorkspaceBinding({ ...inputs(), capsuleKeyringJson: "not-a-binding-field" }),
      /MANAGED_WORKSPACE_BINDING_INVALID/,
    );
  } finally {
    a.attempt.end();
    b.attempt.end();
  }
});
const mismatches = {
  legacyLoginProtocol: inputs({
    loginConfigurationJson: JSON.stringify({
      ...login,
      controllerProtocol: appliedLegacyLoginControllerProtocol(),
    }),
  }),
  unknownLoginProtocol: inputs({
    loginConfigurationJson: JSON.stringify({ ...login, controllerProtocol: "morrow-login-v2" }),
  }),
  logoutProtocol: inputs({
    logoutConfigurationJson: JSON.stringify({ ...logout, protocol: "morrow-self-logout-v2" }),
  }),
  workspaceOrigin: inputs({
    workspaceConfigurationJson: JSON.stringify({
      schemaVersion: 1,
      mode: "https",
      origin: "https://foreign.test",
    }),
  }),
  loopbackMode: inputs({
    workspaceConfigurationJson: JSON.stringify({
      schemaVersion: 1,
      mode: "loopback_qualification",
      origin: login.origin,
    }),
  }),
  logoutOrigin: inputs({
    logoutConfigurationJson: JSON.stringify({ ...logout, origin: "https://foreign.test" }),
  }),
  logoutEnvironment: inputs({
    logoutConfigurationJson: JSON.stringify({
      ...logout,
      environmentId: "environment_" + "Z".repeat(26),
    }),
  }),
  logoutApplication: inputs({
    logoutConfigurationJson: JSON.stringify({ ...logout, applicationId: "app_" + "Z".repeat(26) }),
  }),
  logoutClient: inputs({
    logoutConfigurationJson: JSON.stringify({ ...logout, clientId: "client_" + "Z".repeat(26) }),
  }),
  logoutProfile: inputs({
    logoutConfigurationJson: JSON.stringify({ ...logout, profileId: "other_profile" }),
  }),
  logoutProvider: inputs({
    logoutConfigurationJson: JSON.stringify({ ...logout, providerId: "other" }),
  }),
  callback: inputs({
    loginConfigurationJson: JSON.stringify({
      ...login,
      authenticationBindingJson: JSON.stringify({ ...auth, redirectUri: login.origin + "/other" }),
    }),
  }),
  nestedProvider: inputs({
    loginConfigurationJson: JSON.stringify({
      ...login,
      verificationProfileJson: JSON.stringify({
        ...JSON.parse(login.verificationProfileJson),
        providerId: "other",
      }),
    }),
  }),
  foreignNeon: inputs({ bindingJson: JSON.stringify({ ...binding, hostname: "db.example.test" }) }),
  pooledNeon: inputs({
    bindingJson: JSON.stringify({
      ...binding,
      hostname: "ep-workspace-unit-pooler.c-14.us-east-1.aws.neon.tech",
    }),
  }),
  extraNeonRole: inputs({ bindingJson: JSON.stringify({ ...binding, role: "postgres" }) }),
  unsupportedNeonEnvironment: inputs({
    bindingJson: JSON.stringify({ ...binding, environment: "production" }),
  }),
};
for (const [name, value] of Object.entries(mismatches))
  test(name + " denies synchronously before crypto or any lease interface", async () => {
    await hashes((count) => {
      assert.throws(
        () => captureManagedWorkspaceBinding(value),
        /MANAGED_WORKSPACE_BINDING_INVALID/,
      );
      assert.equal(count(), 0);
    });
  });
for (const field of ["projectId", "branchId", "hostname", "database"])
  test("Neon " + field + " rejects trailing line terminators", () => {
    for (const ending of ["\n", "\r\n"])
      assert.throws(
        () =>
          captureManagedWorkspaceBinding(
            inputs({
              bindingJson: JSON.stringify({ ...binding, [field]: binding[field] + ending }),
            }),
          ),
        /MANAGED_WORKSPACE_BINDING_INVALID/,
      );
  });
test("primitive JSON, duplicate fields, byte bounds and accessor capture are closed", () => {
  for (const value of [
    { ...inputs(), loginConfigurationJson: login },
    {
      ...inputs(),
      workspaceConfigurationJson:
        '{"schemaVersion":1,"schemaVersion":1,"mode":"https","origin":"' + login.origin + '"}',
    },
    {
      ...inputs(),
      workspaceConfigurationJson: JSON.stringify({
        schemaVersion: 1,
        mode: "https",
        origin: "\ud800",
      }),
    },
    { ...inputs(), loginConfigurationJson: " ".repeat(32769) },
    { ...inputs(), bindingJson: " ".repeat(4097) },
    { ...inputs(), extra: true },
  ])
    assert.throws(() => captureManagedWorkspaceBinding(value), /MANAGED_WORKSPACE_BINDING_INVALID/);
  let inspected = false;
  const source = inputs();
  Object.defineProperty(source, "bindingJson", {
    get() {
      inspected = true;
      throw Error("private");
    },
    enumerable: true,
  });
  assert.throws(() => captureManagedWorkspaceBinding(source), /MANAGED_WORKSPACE_BINDING_INVALID/);
  assert.equal(inspected, false);
});
for (const [name, change] of Object.entries({
  environment: "development",
  projectId: "another-project",
  branchId: "br-another",
  hostname: "ep-another.c-14.us-east-1.aws.neon.tech",
  database: "another_db",
}))
  test("application namespace binds exact Neon " + name, async () => {
    const a = authority(),
      b = authority();
    try {
      const one = await resolveManagedWorkspaceBinding(
        captureManagedWorkspaceBinding(inputs()),
        a.attempt,
      );
      const two = await resolveManagedWorkspaceBinding(
        captureManagedWorkspaceBinding(
          inputs({ bindingJson: JSON.stringify({ ...binding, [name]: change }) }),
        ),
        b.attempt,
      );
      assert.notEqual(one.configurationDigest, two.configurationDigest);
      assert.equal(one.login.configurationDigest, two.login.configurationDigest);
    } finally {
      a.attempt.end();
      b.attempt.end();
    }
  });
for (const stage of [1, 2, 3, 4])
  test(
    "authority loss at real hash " + stage + " starts no following hash or returns a binding",
    async () => {
      const a = authority();
      try {
        await hashes(
          async (count) => {
            await assert.rejects(
              resolveManagedWorkspaceBinding(captureManagedWorkspaceBinding(inputs()), a.attempt),
            );
            assert.equal(count(), stage);
          },
          (count, pending) =>
            pending.then((value) => {
              if (count === stage) a.setTime(native.at + 5000);
              return value;
            }),
        );
        assert.throws(() => a.attempt.check());
      } finally {
        a.attempt.end();
      }
    },
  );
test("abort between native Promise creation and first wait check consumes late crypto rejection", async () => {
  const a = authority();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  try {
    await hashes(
      async (count) => {
        const pending = resolveManagedWorkspaceBinding(
          captureManagedWorkspaceBinding(inputs()),
          a.attempt,
        );
        await assert.rejects(pending);
        assert.equal(count(), 1);
        release();
        await new Promise((resolve) => setImmediate(resolve));
      },
      (_count, nativePending) => {
        const pending = nativePending.then(async () => {
          await gate;
          throw Error("disposal-only-late-crypto");
        });
        a.abort.abort();
        return pending;
      },
    );
  } finally {
    release();
    a.attempt.end();
  }
});
test("a failed resolution cannot poison an independent request's original budget", async () => {
  const a = authority(),
    b = authority();
  a.abort.abort();
  try {
    await assert.rejects(
      resolveManagedWorkspaceBinding(captureManagedWorkspaceBinding(inputs()), a.attempt),
    );
    const resolved = await resolveManagedWorkspaceBinding(
      captureManagedWorkspaceBinding(inputs()),
      b.attempt,
    );
    assert.equal(resolved.origin, login.origin);
    assert.equal(b.attempt.control().deadlineMs, native.at + 5000);
  } finally {
    a.attempt.end();
    b.attempt.end();
  }
});
test("managed logout keeps the provided deadline and does not end its caller-owned attempt", async () => {
  const fixture = createStandaloneLogoutFixture();
  await fixture.register("A".repeat(43));
  const entered = fixture.now(),
    attempt = createLoginAttempt(fixture.now, new AbortController().signal, 5000);
  const controls = [],
    pool = {
      async connect(control) {
        controls.push(control);
        return fixture.pool.connect(control);
      },
    };
  try {
    const config = await parseStandaloneLogoutConfigurationWithAttempt(
      fixture.configurationJson,
      attempt,
    );
    fixture.setTime(entered + 4000);
    let delivery;
    await dispatchStandaloneLogoutWithAttempt(
      logoutFixtureRequest(),
      (plan) => {
        delivery = plan;
      },
      attempt,
      config,
      pool,
    );
    assert.equal(delivery.status, 200);
    // P05.T01y-AC26: the post-SQL plan clears the session cookie.
    assert.deepEqual(delivery.cookies, [
      "__Host-morrow_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    ]);
    assert.equal(JSON.parse(delivery.bodyText).outcome, "session_ended");
    assert.equal(controls.length, 1);
    assert.equal(controls[0].deadlineMs, entered + 5000);
    assert.equal(attempt.control().deadlineMs, entered + 5000);
    assert.equal(attempt.check(), entered + 4000);
    assert.equal(fixture.metrics.effects, 1);
    assert.equal(fixture.metrics.releaseCompletions, 1);
  } finally {
    attempt.end();
  }
});
test("legacy and provided-attempt logout preserve identical body/status/SQL decisions", async () => {
  for (const options of [{}, { denied: true }, { roleUnsafe: true }]) {
    const a = createStandaloneLogoutFixture(options),
      b = createStandaloneLogoutFixture(options);
    await Promise.all([a.register("A".repeat(43)), b.register("A".repeat(43))]);
    const old = await createStandaloneLogout(a);
    const original = createLoginAttempt(b.now, new AbortController().signal, 5000);
    try {
      const config = await parseStandaloneLogoutConfigurationWithAttempt(
        b.configurationJson,
        original,
      );
      const response = await old.fetch(logoutFixtureRequest());
      let delivery;
      await dispatchStandaloneLogoutWithAttempt(
        logoutFixtureRequest(),
        (plan) => {
          delivery = plan;
        },
        original,
        config,
        b.pool,
      );
      assert.equal(delivery.status, response.status);
      assert.equal(delivery.bodyText, await response.text());
      assert.deepEqual(delivery.cookies, response.headers.getSetCookie());
      assert.deepEqual(
        delivery.cookies,
        options.roleUnsafe
          ? []
          : ["__Host-morrow_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"],
      );
      assert.deepEqual(
        a.calls.map((v) => v.stage),
        b.calls.map((v) => v.stage),
      );
      assert.equal(original.check(), b.now());
    } finally {
      original.end();
    }
  }
});
test("provided-attempt logout expiry before dispatch has zero SQL and no renewed budget", async () => {
  const f = createStandaloneLogoutFixture(),
    start = f.now();
  const attempt = createLoginAttempt(f.now, new AbortController().signal, 5000);
  try {
    const config = await parseStandaloneLogoutConfigurationWithAttempt(
      f.configurationJson,
      attempt,
    );
    f.setTime(start + 5000);
    let delivery;
    await dispatchStandaloneLogoutWithAttempt(
      logoutFixtureRequest(),
      (p) => {
        delivery = p;
      },
      attempt,
      config,
      f.pool,
    );
    assert.equal(delivery.status, 503);
    assert.equal(JSON.parse(delivery.bodyText).outcome, "logout_unavailable");
    assert.equal(f.metrics.connections, 0);
    assert.equal(attempt.control().deadlineMs, start + 5000);
  } finally {
    attempt.end();
  }
});
