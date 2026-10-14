import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createAuthenticationExchangeAdmission,
  authenticationExchangeAdmissionSql as sql,
  authenticationExchangeCodeChallenge,
  AuthenticationExchangeAdmissionError,
} from "../packages/identity/src/authentication-exchange-admission.ts";

const binding = {
  bindingId: "binding_a",
  bindingRevision: 3,
  environmentId: "environment_" + "A".repeat(26),
  applicationId: "app_" + "B".repeat(26),
  clientId: "client_" + "C".repeat(26),
  redirectUri: "https://morrow.example/auth/callback",
  returnPath: "/work",
};
const commandId = "command_a",
  challengeId = "00000000-0000-4000-8000-000000000001",
  admissionId = "00000000-0000-4000-8000-000000000002";
const callback = {
  commandId,
  challengeId,
  state: Buffer.alloc(32, 1).toString("base64url"),
  browserProof: Buffer.alloc(32, 2).toString("base64url"),
  verifier: Buffer.alloc(32, 3).toString("base64url"),
  code: "opaque provider code",
};
const role = {
  role: "morrow_identity_preauth",
  login: "morrow_identity_preauth",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
};
const hash = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const config = [
  binding.bindingId,
  "3",
  binding.environmentId,
  binding.applicationId,
  binding.clientId,
  binding.redirectUri,
  binding.returnPath,
];
const encode = (patch = {}) => JSON.stringify({ ...callback, ...patch });
function fixture(options = {}) {
  const queries = [],
    releases = [];
  let connections = 0;
  const p = {
    queries,
    releases,
    get connections() {
      return connections;
    },
    async connect() {
      connections++;
      if (options.connectFails) throw options.failure ?? Error("private connect");
      if (options.onConnect) await options.onConnect();
      return {
        async query(text, values) {
          queries.push({ text, values });
          if (options.failAt === text || (options.rollbackFails && text === sql.rollback))
            throw options.failure ?? Error(`private query ${callback.code}`);
          if (text === sql.role) return { rows: options.roleRows ?? [{ ...role }] };
          if (text === sql.create) return { rows: options.rows ?? [{ challenge_id: values[0] }] };
          if (text === sql.admit || text === sql.reconcile)
            return {
              rows: options.rows ?? [
                {
                  outcome: text === sql.reconcile ? "held" : "newly_reserved",
                  admission_id: admissionId,
                },
              ],
            };
          return { rows: [] };
        },
        async release(discard) {
          releases.push(discard);
          if (options.releaseThrows) throw Error(`private release ${callback.state}`);
          if (options.releaseWait) await options.releaseWait;
        },
      };
    },
  };
  return p;
}
const service = (p, b = binding) => createAuthenticationExchangeAdmission(p, JSON.stringify(b));
async function rejectsCode(promise, code, id = commandId) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AuthenticationExchangeAdmissionError);
    assert.equal(error.message, code);
    assert.equal(error.code, code);
    assert.equal(error.commandId, id);
    assert.equal(Object.hasOwn(error, "cause"), false);
    for (const secret of [callback.state, callback.browserProof, callback.verifier, callback.code])
      assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
}
function invalidSync(action) {
  assert.throws(
    action,
    (error) =>
      error instanceof AuthenticationExchangeAdmissionError &&
      error.code === "AUTH_EXCHANGE_INPUT_INVALID" &&
      error.commandId === null,
  );
}
test("RFC7636 AppendixB S256 oracle hashes verifier ASCII rather than decoded random seed", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(
    authenticationExchangeCodeChallenge(verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  assert.notEqual(
    authenticationExchangeCodeChallenge(verifier),
    createHash("sha256").update(Buffer.from(verifier, "base64url")).digest("base64url"),
  );
  for (const value of [null, {}, verifier + "=", "a".repeat(43), "a".repeat(42), "a".repeat(44)])
    invalidSync(() => authenticationExchangeCodeChallenge(value));
});
test("begin generates independent canonical private material and passes only12 ordered commitments to SQL", async () => {
  const p = fixture(),
    s = service(p),
    result = await s.begin(JSON.stringify({ commandId }));
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(Object.keys(result).sort(), [
    "browserProof",
    "challengeId",
    "codeChallenge",
    "codeChallengeMethod",
    "state",
    "verifier",
  ]);
  assert.equal(new Set([result.state, result.browserProof, result.verifier]).size, 3);
  for (const value of [result.state, result.browserProof, result.verifier]) {
    assert.equal(value.length, 43);
    assert.equal(Buffer.from(value, "base64url").length, 32);
    assert.equal(Buffer.from(value, "base64url").toString("base64url"), value);
    assert.ok(!JSON.stringify(p.queries).includes(value));
  }
  assert.equal(result.codeChallengeMethod, "S256");
  assert.equal(
    result.codeChallenge,
    createHash("sha256").update(result.verifier, "ascii").digest("base64url"),
  );
  const values = p.queries.find((q) => q.text === sql.create).values;
  assert.deepEqual(values, [
    result.challengeId,
    commandId,
    ...config,
    hash(result.state),
    hash(result.browserProof),
    hash(result.verifier),
  ]);
  assert.ok(Object.isFrozen(values));
  assert.deepEqual(
    p.queries.map((q) => q.text),
    [sql.begin, sql.role, sql.timeout, sql.idleTimeout, sql.create, sql.commit],
  );
  assert.deepEqual(p.releases, [false]);
});
test("duplicate begin yields null without disclosing regenerated or original material", async () => {
  const p = fixture({ rows: [] });
  assert.equal(await service(p).begin(JSON.stringify({ commandId })), null);
  assert.equal(p.queries.at(-1).text, sql.commit);
  assert.equal(p.queries.filter((q) => q.text === sql.create).length, 1);
});
test("admit hashes exact private callback values into13 ordered parameters and returns correlation only", async () => {
  const p = fixture(),
    result = await service(p).admit(encode());
  assert.deepEqual(result, { outcome: "newly_reserved", admissionId, commandId });
  assert.ok(Object.isFrozen(result));
  const values = p.queries.find((q) => q.text === sql.admit).values;
  assert.deepEqual(values, [
    commandId,
    challengeId,
    ...config,
    hash(callback.state),
    hash(callback.browserProof),
    hash(callback.verifier),
    hash(callback.code),
  ]);
  assert.ok(Object.isFrozen(values));
  assert.deepEqual(
    p.queries.map((q) => q.text),
    [sql.begin, sql.role, sql.timeout, sql.idleTimeout, sql.admit, sql.commit],
  );
  for (const secret of [callback.state, callback.browserProof, callback.verifier, callback.code])
    assert.ok(!JSON.stringify(p.queries).includes(secret));
});
test("read-only reconcile uses only the lookup and never emits new admission", async () => {
  for (const visible of [admissionId, null]) {
    const p = fixture({ rows: [{ outcome: "held", admission_id: visible }] });
    assert.deepEqual(await service(p).reconcile(encode()), {
      outcome: "held",
      admissionId: visible,
      commandId,
    });
    assert.deepEqual(
      p.queries.map((q) => q.text),
      [sql.beginReadOnly, sql.role, sql.timeout, sql.idleTimeout, sql.reconcile, sql.commit],
    );
    assert.ok(!p.queries.some((q) => q.text === sql.admit || q.text === sql.create));
  }
});
test("raw object, boxed string, proxy and accessor inputs are rejected without any reflection", async () => {
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      getPrototypeOf() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw Error();
      },
    },
  );
  const accessor = {
    get commandId() {
      traps++;
      throw Error();
    },
  };
  for (const value of [
    hostile,
    accessor,
    binding,
    callback,
    new String(encode()),
    null,
    3,
    false,
    [],
  ]) {
    const p = fixture();
    invalidSync(() => createAuthenticationExchangeAdmission(p, value));
    const s = service(p);
    for (const method of ["begin", "admit", "reconcile"])
      await rejectsCode(s[method](value), "AUTH_EXCHANGE_INPUT_INVALID", null);
    assert.equal(p.connections, 0);
  }
  assert.equal(traps, 0);
});
test("binding is closed, typed and pinned to exact WorkOS selectors/callback/relative return", () => {
  const missing = { ...binding };
  delete missing.bindingRevision;
  const malformed = [
    missing,
    { ...binding, extra: true },
    { ...binding, bindingRevision: "3" },
    { ...binding, environmentId: "environment_bad" },
    { ...binding, applicationId: "app_bad" },
    { ...binding, clientId: "client_bad" },
    { ...binding, bindingId: "bad/id" },
    ...[
      "http://morrow.example/callback",
      "https://a:b@morrow.example/callback",
      "https://morrow.example/callback#x",
      "https://morrow.example/callback#",
      "https://morrow.example/callback?x=1",
      "https://morrow.example/callback?",
      "https://*.example/callback",
      "https://morrow.example:443/callback",
    ].map((redirectUri) => ({ ...binding, redirectUri })),
    ...[
      "//foreign.example",
      "/../outside",
      "/work?next=foreign",
      "https://foreign.example",
      "/" + "x".repeat(512),
    ].map((returnPath) => ({ ...binding, returnPath })),
  ];
  for (const b of malformed) invalidSync(() => service(fixture(), b));
  for (const redirectUri of [
    "http://localhost:4100/auth/callback",
    "http://127.0.0.1:4100/auth/callback",
    "http://[::1]:4100/auth/callback",
  ])
    assert.ok(service(fixture(), { ...binding, redirectUri }));
  const text = JSON.stringify(binding),
    p = fixture();
  assert.ok(createAuthenticationExchangeAdmission(p, text + " ".repeat(8192 - text.length)));
  invalidSync(() =>
    createAuthenticationExchangeAdmission(p, text + " ".repeat(8193 - text.length)),
  );
});
test("malformed and additional callback/begin authority fields deny before connecting", async () => {
  const missing = { ...callback };
  delete missing.code;
  const invalid = [
    "",
    "{bad",
    "null",
    "[]",
    JSON.stringify(missing),
    encode({ approved: true }),
    encode({ authenticated: true }),
    encode({ commandId: "bad/id" }),
    encode({ challengeId: "not_uuid" }),
    encode({ state: "a".repeat(43) }),
    encode({ browserProof: callback.browserProof + "=" }),
    encode({ verifier: [] }),
    encode({ code: 123 }),
    encode({ code: "" }),
    encode({ code: "x".repeat(4097) }),
    encode({ code: "\ud800" }),
    encode({ code: "\udc00" }),
    encode({ code: "a\ud800b" }),
    encode({ code: "\udc00\ud800" }),
    " ".repeat(16385),
  ];
  for (const value of invalid)
    for (const method of ["admit", "reconcile"]) {
      const p = fixture();
      await rejectsCode(service(p)[method](value), "AUTH_EXCHANGE_INPUT_INVALID", null);
      assert.equal(p.connections, 0);
    }
  for (const value of [
    "{}",
    '{"commandId":"bad/id"}',
    '{"commandId":"command_a","challengeId":"extra"}',
    " ".repeat(8193),
  ]) {
    const p = fixture();
    await rejectsCode(service(p).begin(value), "AUTH_EXCHANGE_INPUT_INVALID", null);
    assert.equal(p.connections, 0);
  }
});
test("opaque valid UTF16 code is hashed exactly without trim, case folding or Unicode normalization", async () => {
  const digests = [];
  for (const code of [
    " ",
    "\u0000",
    "Case",
    "case",
    " e\u0301 ",
    " é ",
    "😀",
    "\n\t'\"",
    "x".repeat(4096),
  ]) {
    const p = fixture();
    await service(p).admit(encode({ code }));
    const actual = p.queries.find((q) => q.text === sql.admit).values.at(-1);
    assert.equal(actual, hash(code));
    digests.push(actual);
  }
  assert.equal(new Set(digests).size, digests.length);
  const text = encode(),
    p = fixture();
  await service(p).admit(text + " ".repeat(16384 - text.length));
});
test("factory and callback snapshots cannot be retargeted during a connection await", async () => {
  const mutableBinding = { ...binding },
    mutableCallback = { ...callback };
  let bindingText = JSON.stringify(mutableBinding),
    callbackText = JSON.stringify(mutableCallback);
  const p = fixture({
    onConnect: async () => {
      mutableBinding.clientId = "foreign";
      mutableCallback.code = "foreign";
      bindingText = "{}";
      callbackText = "{}";
    },
  });
  const s = createAuthenticationExchangeAdmission(p, bindingText);
  await s.admit(callbackText);
  assert.deepEqual(p.queries.find((q) => q.text === sql.admit).values, [
    commandId,
    challengeId,
    ...config,
    hash(callback.state),
    hash(callback.browserProof),
    hash(callback.verifier),
    hash(callback.code),
  ]);
});
test("private begin material and fresh admission remain withheld until awaited release succeeds", async () => {
  for (const method of ["begin", "admit"]) {
    let unblock;
    const releaseWait = new Promise((resolve) => {
      unblock = resolve;
    });
    const p = fixture({ releaseWait }),
      s = service(p);
    let settled = false;
    const pending = s[method](method === "begin" ? JSON.stringify({ commandId }) : encode()).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(p.queries.at(-1).text, sql.commit);
    assert.equal(settled, false);
    unblock();
    const result = await pending;
    assert.ok(result);
    assert.equal(settled, true);
  }
});
test("unsafe dedicated roles and memberships rollback before invoking any admission function", async () => {
  const patches = [
    { role: "morrow_api" },
    { role: "morrow_identity_owner" },
    { role: "morrow_identity_linking" },
    { login: "morrow_api" },
    ...[
      "rolsuper",
      "rolbypassrls",
      "rolcreatedb",
      "rolcreaterole",
      "rolinherit",
      "owner_member",
      "role_member",
    ].map((key) => ({ [key]: true })),
    { role_member: "false" },
    { extra: true },
  ];
  for (const rows of [[], [{ ...role }, { ...role }], ...patches.map((p) => [{ ...role, ...p }])]) {
    const p = fixture({ roleRows: rows });
    await rejectsCode(service(p).admit(encode()), "AUTH_EXCHANGE_UNAVAILABLE");
    assert.ok(!p.queries.some((q) => [sql.create, sql.admit, sql.reconcile].includes(q.text)));
    assert.equal(p.queries.at(-1).text, sql.rollback);
    assert.deepEqual(p.releases, [true]);
  }
});
test("begin decodes only zero rows or one exact generated challenge UUID", async () => {
  for (const rows of [
    [{ challenge_id: challengeId }],
    [{ challenge_id: null }],
    [{ challenge_id: challengeId, extra: true }],
    [{ challenge_id: challengeId }, { challenge_id: challengeId }],
  ]) {
    const p = fixture({ rows });
    await rejectsCode(service(p).begin(JSON.stringify({ commandId })), "AUTH_EXCHANGE_UNAVAILABLE");
    assert.equal(p.queries.at(-1).text, sql.rollback);
  }
});
test("admit accepts only the closed nullable correlation matrix", async () => {
  for (const row of [
    { outcome: "newly_reserved", admission_id: admissionId },
    { outcome: "held", admission_id: admissionId },
    { outcome: "held", admission_id: null },
    { outcome: "denied", admission_id: null },
    { outcome: "conflict", admission_id: null },
  ]) {
    const p = fixture({ rows: [row] });
    assert.deepEqual(await service(p).admit(encode()), {
      outcome: row.outcome,
      admissionId: row.admission_id,
      commandId,
    });
    assert.equal(p.queries.at(-1).text, sql.commit);
  }
  for (const rows of [
    [],
    [{ outcome: "newly_reserved", admission_id: null }],
    [{ outcome: "denied", admission_id: admissionId }],
    [{ outcome: "conflict", admission_id: admissionId }],
    [{ outcome: "held", admission_id: "bad" }],
    [{ outcome: "authenticated", admission_id: admissionId }],
    [{ outcome: "held", admission_id: admissionId, execute: true }],
    [{ outcome: "held" }],
    [
      { outcome: "held", admission_id: null },
      { outcome: "held", admission_id: null },
    ],
  ]) {
    const p = fixture({ rows });
    await rejectsCode(service(p).admit(encode()), "AUTH_EXCHANGE_UNAVAILABLE");
    assert.equal(p.queries.at(-1).text, sql.rollback);
  }
});
test("reconcile rejects newly_reserved or all nonheld results without calling a write", async () => {
  for (const outcome of ["newly_reserved", "denied", "conflict", "authenticated"]) {
    const p = fixture({ rows: [{ outcome, admission_id: admissionId }] });
    await rejectsCode(service(p).reconcile(encode()), "AUTH_EXCHANGE_UNAVAILABLE");
    assert.ok(!p.queries.some((q) => q.text === sql.admit || q.text === sql.create));
    assert.equal(p.queries.at(-1).text, sql.rollback);
  }
});
test("query and connection failures are redacted, rolled back and discarded without retry", async () => {
  let traps = 0;
  const failure = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      getPrototypeOf() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
    },
  );
  for (const failAt of [
    sql.begin,
    sql.role,
    sql.timeout,
    sql.idleTimeout,
    sql.create,
    sql.admit,
    sql.reconcile,
  ]) {
    const p = fixture({ failAt, failure, rollbackFails: true });
    const method =
      failAt === sql.create ? "begin" : failAt === sql.reconcile ? "reconcile" : "admit";
    await rejectsCode(
      service(p)[method](method === "begin" ? JSON.stringify({ commandId }) : encode()),
      "AUTH_EXCHANGE_UNAVAILABLE",
    );
    assert.equal(p.queries.at(-1).text, sql.rollback);
    assert.deepEqual(p.releases, [true]);
    assert.ok(
      p.queries.filter((q) => [sql.create, sql.admit, sql.reconcile].includes(q.text)).length <= 1,
    );
  }
  const p = fixture({ connectFails: true, failure });
  await rejectsCode(service(p).admit(encode()), "AUTH_EXCHANGE_UNAVAILABLE");
  assert.equal(p.queries.length, 0);
  assert.equal(traps, 0);
});
test("COMMIT acknowledgement loss or release failure withholds all results and preserves stable uncertainty", async () => {
  for (const method of ["begin", "admit", "reconcile"])
    for (const option of [{ failAt: sql.commit }, { releaseThrows: true }]) {
      const p = fixture(option);
      await rejectsCode(
        service(p)[method](method === "begin" ? JSON.stringify({ commandId }) : encode()),
        "AUTH_EXCHANGE_UNCERTAIN",
      );
      assert.equal(p.queries.at(-1).text, sql.commit);
      assert.ok(!p.queries.some((q) => q.text === sql.rollback));
      assert.equal(
        p.queries.filter((q) => [sql.create, sql.admit, sql.reconcile].includes(q.text)).length,
        1,
      );
    }
});
