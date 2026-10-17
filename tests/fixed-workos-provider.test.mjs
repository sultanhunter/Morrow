import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createFixedWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-provider.mjs";
import { createSyntheticFixedWorkosLoginPort } from "../packages/identity/src/fixed-workos-login-port.ts";
const verifier = Buffer.alloc(32, 13).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const request = (body, changes = {}) => ({
  method: "POST",
  redirect: "error",
  credentials: "omit",
  cache: "no-store",
  signal: new AbortController().signal,
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  body: JSON.stringify(body),
  ...changes,
});
const body = (oracle, issued, changes = {}) => ({
  client_id: oracle.profile.clientId,
  grant_type: "authorization_code",
  code: issued.code,
  code_verifier: verifier,
  ...changes,
});
test("independent provider attests four-field S256 exchange and real native RSA signature", async () => {
  const oracle = createFixedWorkosProviderOracle(),
    issued = oracle.issueCode({ challenge });
  const response = await oracle.fetch(
    "https://api.workos.com/user_management/authenticate",
    request(body(oracle, issued)),
  );
  const output = await response.json();
  assert.equal(output.access_token, issued.token);
  const segments = output.access_token.split(".");
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(segments.slice(0, 2).join(".")),
      createPublicKey({ key: oracle.publicJwk, format: "jwk" }),
      Buffer.from(segments[2], "base64url"),
    ),
    true,
  );
  assert.deepEqual(JSON.parse(Buffer.from(segments[1], "base64url")), issued.claims);
  assert.deepEqual(oracle.calls, [{ kind: "exchange", method: "POST", managementMarker: false }]);
  assert.equal(oracle.metrics.borrows, 0);
  await assert.rejects(
    oracle.fetch(
      "https://api.workos.com/user_management/authenticate",
      request(body(oracle, issued)),
    ),
  );
});
for (const [name, changes, init] of [
  ["foreign client", { client_id: "client_foreign" }, {}],
  ["wrong verifier", { code_verifier: Buffer.alloc(32, 12).toString("base64url") }, {}],
  [
    "extra redirect field",
    { redirect_uri: "https://workspace.example.test/auth/workos/callback" },
    {},
  ],
  ["extra client secret", { client_secret: "forbidden" }, {}],
  [
    "management header on POST",
    {},
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer forbidden",
      },
    },
  ],
  ["redirect following", {}, { redirect: "follow" }],
  ["credential cookies", {}, { credentials: "include" }],
])
  test("oracle rejects " + name + " independently", async () => {
    const oracle = createFixedWorkosProviderOracle(),
      issued = oracle.issueCode({ challenge });
    await assert.rejects(
      oracle.fetch(
        "https://api.workos.com/user_management/authenticate",
        request(body(oracle, issued, changes), init),
      ),
    );
    assert.equal(oracle.metrics.requests, 0);
  });
test("anonymous bound JWKS and separately leased marker only on exact session GET", async () => {
  const oracle = createFixedWorkosProviderOracle(),
    issued = oracle.issueCode({ challenge });
  await oracle.fetch(
    "https://api.workos.com/user_management/authenticate",
    request(body(oracle, issued)),
  );
  const get = {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: new AbortController().signal,
    headers: { Accept: "application/json" },
  };
  const keys = await oracle.fetch(
    `https://api.workos.com/sso/jwks/${oracle.profile.clientId}`,
    get,
  );
  assert.deepEqual(await keys.json(), { keys: [oracle.publicJwk] });
  assert.equal(oracle.metrics.borrows, 0);
  const control = { deadlineMs: oracle.now() + 1000, signal: new AbortController().signal };
  const lease = await oracle.broker.borrow(oracle.expectedNamespaceJson, control);
  const url = `https://api.workos.com/user_management/users/${issued.claims.sub}/sessions?limit=100&order=asc`;
  const page = await oracle.fetch(url, {
    ...get,
    headers: { Accept: "application/json", Authorization: "Bearer " + lease.credential },
  });
  const parsed = await page.json();
  assert.equal(parsed.data.length, 1);
  assert.equal(parsed.data[0].id, issued.claims.sid);
  assert.deepEqual(parsed.list_metadata, { before: null, after: null });
  await lease.release(control);
  assert.equal(oracle.metrics.activeLeases, 0);
  assert.equal(oracle.metrics.releaseCompletions, 1);
  assert.deepEqual(
    oracle.calls.map((call) => call.managementMarker),
    [false, false, true],
  );
});
test("independent authorization registration binds client, callback and S256", () => {
  const oracle = createFixedWorkosProviderOracle();
  const url = new URL("https://api.workos.com/user_management/authorize");
  const cfg = JSON.parse(JSON.parse(oracle.configurationJson).authenticationBindingJson);
  for (const [key, value] of Object.entries({
    client_id: oracle.profile.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    provider: "authkit",
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    url.searchParams.set(key, value);
  const issued = oracle.arm(url.href);
  assert.equal(new URL(issued.callbackUrl).searchParams.get("code"), issued.code);
  url.searchParams.set("redirect_uri", "https://foreign.example.test/auth/workos/callback");
  assert.throws(() => oracle.arm(url.href));
});
test("real fixed port passes independent HTTP/S256/RSA oracle and returns no dropped secrets", async () => {
  const oracle = createFixedWorkosProviderOracle(),
    issued = oracle.issueCode({ challenge });
  const port = await createSyntheticFixedWorkosLoginPort({
    configurationJson: oracle.configurationJson,
    sessionCredentialBroker: oracle.broker,
    now: oracle.now,
    fetch: oracle.fetch,
  });
  const control = { deadlineMs: oracle.now() + 10000, signal: new AbortController().signal };
  const binding = JSON.parse(oracle.authenticationBindingJson);
  const exchanged = await port.exchange(
    JSON.stringify({
      schemaVersion: 1,
      admissionId: "03d0144a-f65e-4a7f-a7d5-b9b6783440c2",
      code: issued.code,
      verifier,
      clientId: oracle.profile.clientId,
      redirectUri: binding.redirectUri,
    }),
    control,
  );
  assert.deepEqual(JSON.parse(exchanged), { schemaVersion: 1, accessToken: issued.token });
  const snapshot = JSON.parse(await port.readPublicKeyset(control));
  assert.equal(snapshot.clientId, oracle.profile.clientId);
  assert.deepEqual(snapshot.jwks, { keys: [oracle.publicJwk] });
  const page = JSON.parse(
    await port.readSessionPage(
      JSON.stringify({
        schemaVersion: 1,
        subjectId: issued.claims.sub,
        after: null,
        limit: 100,
        order: "asc",
      }),
      control,
    ),
  );
  assert.equal(page.data[0].id, issued.claims.sid);
  assert.deepEqual(
    oracle.calls.map((call) => call.kind),
    ["exchange", "publicKeyset", "sessionPage"],
  );
  assert.deepEqual(
    oracle.calls.map((call) => call.managementMarker),
    [false, false, true],
  );
  assert.equal(oracle.metrics.borrows, 1);
  assert.equal(oracle.metrics.releaseAttempts, 1);
  assert.equal(oracle.metrics.releaseCompletions, 1);
  assert.equal(oracle.metrics.activeLeases, 0);
  for (const secret of oracle.secrets) assert.ok(!exchanged.includes(secret));
});
test("one real fixed port supports independently registered concurrent callbacks", async () => {
  const oracle = createFixedWorkosProviderOracle();
  const issued = [oracle.issueCode({ challenge }), oracle.issueCode({ challenge })];
  const port = await createSyntheticFixedWorkosLoginPort({
    configurationJson: oracle.configurationJson,
    sessionCredentialBroker: oracle.broker,
    now: oracle.now,
    fetch: oracle.fetch,
  });
  const control = { deadlineMs: oracle.now() + 10000, signal: new AbortController().signal };
  const binding = JSON.parse(oracle.authenticationBindingJson);
  const outputs = await Promise.all(
    issued.map((value) =>
      port.exchange(
        JSON.stringify({
          schemaVersion: 1,
          admissionId: "03d0144a-f65e-4a7f-a7d5-b9b6783440c2",
          code: value.code,
          verifier,
          clientId: oracle.profile.clientId,
          redirectUri: binding.redirectUri,
        }),
        control,
      ),
    ),
  );
  assert.deepEqual(
    outputs.map((text) => JSON.parse(text).accessToken),
    issued.map((value) => value.token),
  );
  assert.equal(oracle.metrics.exchange, 2);
  assert.equal(oracle.metrics.borrows, 0);
});
