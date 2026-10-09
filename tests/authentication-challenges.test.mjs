import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createAuthenticationChallenges,
  authenticationSql,
} from "../packages/identity/src/authentication-challenges.ts";
import { identitySql } from "../packages/identity/src/index.ts";
const binding = {
  id: "binding_a",
  environmentId: "environment_a",
  clientId: "client_" + "A".repeat(26),
  redirectUri: "http://127.0.0.1:3001/auth/callback",
  returnPath: "/",
};
const hash = (s) => createHash("sha256").update(s).digest("hex");
const role = {
  role: "morrow_api",
  login: "morrow_api",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  owner_member: false,
};
function pool(options = {}) {
  const calls = [],
    releases = [];
  let stored;
  return {
    calls,
    releases,
    async connect() {
      if (options.connect) throw Error("secret_connect_detail");
      return {
        async query(text, values = []) {
          calls.push({ text, values });
          if (options.fail === text) throw Error("secret_database_detail");
          if (text === identitySql.role) return { rows: [{ ...role, ...options.role }] };
          if (text === authenticationSql.create) {
            stored = [...values];
            return { rows: options.rows ?? [{ challenge_id: values[0] }] };
          }
          if (text === authenticationSql.consume) {
            if (options.rows) return { rows: options.rows };
            const match = stored && values.join(",") === [stored[1], ...stored.slice(2)].join(",");
            const rows = match ? [{ challenge_id: stored[0] }] : [];
            if (match) stored = null;
            return { rows };
          }
          return { rows: [] };
        },
        release(discard) {
          releases.push(discard);
          if (options.release) throw Error("secret_release_detail");
        },
      };
    },
  };
}
test("generated independent proofs are 256-bit canonical values and only digests reach SQL", async () => {
  const p = pool(),
    service = createAuthenticationChallenges(p, binding),
    proofs = await service.begin();
  assert.equal(proofs.state.length, 43);
  assert.equal(proofs.browserProof.length, 43);
  assert.notEqual(proofs.state, proofs.browserProof);
  assert.equal(Buffer.from(proofs.state, "base64url").length, 32);
  assert.equal(proofs.maxAgeSeconds, 300);
  const call = p.calls.find((c) => c.text === authenticationSql.create);
  assert.equal(call.values[2], hash(proofs.state));
  assert.equal(call.values[3], hash(proofs.browserProof));
  assert.equal(JSON.stringify(p.calls).includes(proofs.state), false);
  assert.equal(JSON.stringify(p.calls).includes(proofs.browserProof), false);
  assert.deepEqual(call.values.slice(4), [
    binding.environmentId,
    binding.clientId,
    binding.redirectUri,
    binding.returnPath,
  ]);
  const result = await service.consume({ state: proofs.state, browserProof: proofs.browserProof });
  assert.deepEqual(Object.keys(result).sort(), ["binding", "challengeId"]);
  assert.deepEqual(result.binding, binding);
  assert.ok(Object.isFrozen(result.binding));
  await assert.rejects(
    () => service.consume({ state: proofs.state, browserProof: proofs.browserProof }),
    { code: "CHALLENGE_DENIED" },
  );
});
test("wrong browser proof is denied without claiming authentication", async () => {
  const service = createAuthenticationChallenges(pool(), binding),
    p = await service.begin();
  await assert.rejects(() => service.consume({ state: p.state, browserProof: "A".repeat(43) }), {
    code: "CHALLENGE_DENIED",
  });
  assert.ok((await service.consume({ state: p.state, browserProof: p.browserProof })).challengeId);
});
test("configuration is snapshotted before asynchronous persistence", async () => {
  const b = { ...binding },
    p = pool(),
    service = createAuthenticationChallenges(p, b);
  b.clientId = "client_" + "B".repeat(26);
  await service.begin();
  assert.equal(
    p.calls.find((c) => c.text === authenticationSql.create).values[5],
    binding.clientId,
  );
});
const badConfigs = {
  unknown: { ...binding, authority: true },
  wildcard: { ...binding, redirectUri: "https://*.example.com/auth/callback" },
  wildcardPath: { ...binding, redirectUri: "https://example.com/auth/*" },
  insecure: { ...binding, redirectUri: "http://example.com/auth/callback" },
  query: { ...binding, redirectUri: binding.redirectUri + "?token=secret" },
  fragment: { ...binding, redirectUri: binding.redirectUri + "#fragment" },
  credentials: { ...binding, redirectUri: "https://user:password@example.com/auth/callback" },
  noncanonical: { ...binding, redirectUri: "HTTPS://EXAMPLE.COM/auth/callback" },
  foreignReturn: { ...binding, returnPath: "//example.com" },
  encodedReturn: { ...binding, returnPath: "/%2f%2fexample.com" },
  parentReturn: { ...binding, returnPath: "/../admin" },
  queryReturn: { ...binding, returnPath: "/?workspace=foreign" },
  malformedClient: { ...binding, clientId: "client_*" },
  malformedEnvironment: { ...binding, environmentId: "environment/foreign" },
  inherited: Object.assign(Object.create({ authority: true }), binding),
  accessor: {
    ...binding,
    get id() {
      throw Error("ACCESSOR_MUST_NOT_RUN");
    },
  },
  symbol: { ...binding, [Symbol("authority")]: true },
};
for (const [name, b] of Object.entries(badConfigs))
  test("invalid server binding rejected: " + name, () =>
    assert.throws(() => createAuthenticationChallenges(pool(), b), { code: "CHALLENGE_DENIED" }),
  );
for (const [name, proof] of Object.entries({
  missing: {},
  null: null,
  extra: { state: "A".repeat(43), browserProof: "A".repeat(43), clientId: binding.clientId },
  padding: { state: "A".repeat(43) + "=", browserProof: "A".repeat(43) },
  short: { state: "A", browserProof: "A".repeat(43) },
  noncanonical: { state: "A".repeat(42) + "B", browserProof: "A".repeat(43) },
  symbol: { state: "A".repeat(43), browserProof: "A".repeat(43), [Symbol("authority")]: true },
}))
  test("malformed callback rejected before connection: " + name, async () => {
    const p = pool(),
      service = createAuthenticationChallenges(p, binding);
    await assert.rejects(() => service.consume(proof), { code: "CHALLENGE_DENIED" });
    assert.equal(p.calls.length, 0);
  });
for (const [name, r] of Object.entries({
  superuser: { rolsuper: true },
  bypass: { rolbypassrls: true },
  owner: { owner_member: true },
  createdb: { rolcreatedb: true },
  createrole: { rolcreaterole: true },
  foreign: { role: "postgres" },
  setRole: { login: "postgres" },
}))
  test("unprivileged runtime role required: " + name, async () => {
    const p = pool({ role: r });
    await assert.rejects(() => createAuthenticationChallenges(p, binding).begin(), {
      code: "CHALLENGE_DENIED",
    });
    assert.equal(
      p.calls.some((c) => c.text === authenticationSql.create),
      false,
    );
    assert.equal(p.calls.at(-1).text, identitySql.rollback);
  });
for (const step of [
  authenticationSql.begin,
  identitySql.role,
  identitySql.timeout,
  identitySql.idleTimeout,
  authenticationSql.create,
  identitySql.commit,
])
  test("database failure is redacted and rolled back: " + step, async () => {
    const p = pool({ fail: step });
    await assert.rejects(
      () => createAuthenticationChallenges(p, binding).begin(),
      (e) => e.code === "CHALLENGE_UNAVAILABLE" && !e.message.includes("secret") && !e.cause,
    );
    assert.equal(p.calls.at(-1).text, identitySql.rollback);
    assert.deepEqual(p.releases, [false]);
  });
test("empty database result cannot prove a challenge", async () =>
  assert.rejects(() => createAuthenticationChallenges(pool({ rows: [] }), binding).begin(), {
    code: "CHALLENGE_DENIED",
  }));
test("arbitrary SQL result cannot become identity", async () =>
  assert.rejects(
    () =>
      createAuthenticationChallenges(
        pool({ rows: [{ challenge_id: "actor_a", actor: role }] }),
        binding,
      ).begin(),
    { code: "CHALLENGE_DENIED" },
  ));
test("connection and release failures carry no raw provider detail", async () => {
  for (const opts of [{ connect: true }, { release: true }])
    await assert.rejects(
      () => createAuthenticationChallenges(pool(opts), binding).begin(),
      (e) => e.code === "CHALLENGE_UNAVAILABLE" && !e.message.includes("secret"),
    );
});
test("failed rollback discards the connection", async () => {
  const p = pool({ role: { owner_member: true }, fail: identitySql.rollback });
  await assert.rejects(() => createAuthenticationChallenges(p, binding).begin(), {
    code: "CHALLENGE_DENIED",
  });
  assert.deepEqual(p.releases, [true]);
});
test("proxy traps cannot leak arbitrary configuration or callback details", async () => {
  const trapped = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw Error("secret_proxy_detail");
      },
    },
  );
  assert.throws(() => createAuthenticationChallenges(pool(), trapped), {
    code: "CHALLENGE_DENIED",
  });
  const p = pool();
  await assert.rejects(() => createAuthenticationChallenges(p, binding).consume(trapped), {
    code: "CHALLENGE_DENIED",
  });
  assert.equal(p.calls.length, 0);
});
