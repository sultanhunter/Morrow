import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";

const verifier = Buffer.alloc(32, 29).toString("base64url");
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
const post = (oracle, issued, changes = {}) =>
  new Request("https://api.workos.com/user_management/authenticate", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...changes.headers },
    body:
      changes.raw ??
      JSON.stringify({
        client_id: oracle.profile.clientId,
        grant_type: "authorization_code",
        code: issued.code,
        code_verifier: changes.verifier ?? verifier,
      }),
  });
test("platform oracle accepts independent S256 and returns actual unstamped Response", async () => {
  const oracle = createPlatformWorkosProviderOracle();
  const issued = oracle.issueAuthorization({ challenge });
  const response = await oracle.handleRequest(post(oracle, issued));
  assert.equal(response.url, "");
  assert.equal(response.redirected, false);
  assert.equal((await response.json()).access_token, issued.token);
  assert.equal(oracle.metrics.exchange, 1);
  assert.equal(oracle.metrics.oracleFailures, 0);
});
test("unregistered code cannot derive expected challenge from the submitted verifier", async () => {
  const oracle = createPlatformWorkosProviderOracle();
  await assert.rejects(
    oracle.handleRequest(post(oracle, { code: "unregistered" })),
    /PLATFORM_HTTP_ORACLE_REJECTED/,
  );
  assert.equal(oracle.metrics.exchange, 0);
});
test("wrong independent proof and code replay reject", async () => {
  const oracle = createPlatformWorkosProviderOracle();
  const issued = oracle.issueAuthorization({ challenge });
  await assert.rejects(
    oracle.handleRequest(
      post(oracle, issued, { verifier: Buffer.alloc(32, 30).toString("base64url") }),
    ),
    /PLATFORM_HTTP_ORACLE_REJECTED/,
  );
  await oracle.handleRequest(post(oracle, issued));
  await assert.rejects(oracle.handleRequest(post(oracle, issued)), /PLATFORM_HTTP_ORACLE_REJECTED/);
  assert.equal(oracle.metrics.exchange, 1);
});
test("four-field duplicate-free keyless body is required", async () => {
  const oracle = createPlatformWorkosProviderOracle();
  const issued = oracle.issueAuthorization({ challenge });
  for (const raw of [
    JSON.stringify({
      client_id: oracle.profile.clientId,
      grant_type: "authorization_code",
      code: issued.code,
      code_verifier: verifier,
      client_secret: "forbidden",
    }),
    '{"code":"a","code":"b"}',
  ])
    await assert.rejects(
      oracle.handleRequest(post(oracle, issued, { raw })),
      /PLATFORM_HTTP_ORACLE_REJECTED/,
    );
  assert.equal(oracle.metrics.exchange, 0);
});
test("public method rejects broad credentials and forbidden cookies", async () => {
  const oracle = createPlatformWorkosProviderOracle();
  for (const headers of [
    { authorization: "Bearer forbidden" },
    { cookie: "forbidden" },
    { referer: "https://foreign.invalid" },
  ])
    await assert.rejects(
      oracle.handleRequest(
        new Request("https://api.workos.com/sso/jwks/" + oracle.profile.clientId, {
          headers: { Accept: "application/json", ...headers },
        }),
      ),
      /PLATFORM_HTTP_ORACLE_REJECTED/,
    );
  assert.equal(oracle.metrics.publicKeyset, 0);
});
test("foreign origin/path/userinfo/query fail closed without network fallback", async () => {
  const oracle = createPlatformWorkosProviderOracle();
  for (const url of [
    "https://foreign.invalid/",
    "https://api.workos.com/never-follow",
    "https://api.workos.com/sso/jwks/" + oracle.profile.clientId + "?extra=1",
  ])
    await assert.rejects(
      oracle.handleRequest(new Request(url, { headers: { Accept: "application/json" } })),
      /PLATFORM_HTTP_ORACLE_REJECTED/,
    );
  assert.equal(oracle.metrics.actualInternetRequests, 0);
});
test("fixed active catalogue needs a valid session marker and separately seeded session", async () => {
  const oracle = createPlatformWorkosProviderOracle();
  const issued = oracle.issueAuthorization({ challenge });
  const url =
    "https://api.workos.com/user_management/users/" +
    issued.claims.sub +
    "/sessions?limit=100&order=asc";
  const request = () =>
    new Request(url, {
      headers: { Accept: "application/json", Authorization: "Bearer " + oracle.marker },
    });
  await assert.rejects(oracle.handleRequest(request()), /PLATFORM_HTTP_ORACLE_REJECTED/);
  oracle.activate(issued);
  const page = await (await oracle.handleRequest(request())).json();
  assert.equal(page.data.length, 1);
  assert.equal(page.data[0].id, issued.claims.sid);
});
test("actual authorization URL is registered before the keyless POST", async () => {
  const oracle = createPlatformWorkosProviderOracle();
  const url = new URL("https://api.workos.com/user_management/authorize");
  for (const [key, value] of Object.entries({
    client_id: oracle.profile.clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    provider: "authkit",
    redirect_uri: oracle.callback,
    response_type: "code",
    state: "independent_state",
  }))
    url.searchParams.set(key, value);
  const issued = oracle.arm(url.href);
  assert.equal(new URL(issued.callbackUrl).searchParams.get("state"), "independent_state");
  await oracle.handleRequest(post(oracle, issued));
  url.searchParams.set("redirect_uri", "https://foreign.invalid/callback");
  assert.throws(() => oracle.arm(url.href));
});
test("gzip fixture supplies decoded bytes for the bridge's single encoding pass", async () => {
  const oracle = createPlatformWorkosProviderOracle({ fault: { name: "gzip" } });
  const response = await oracle.handleRequest(
    new Request("https://api.workos.com/sso/jwks/" + oracle.profile.clientId, {
      headers: { Accept: "application/json" },
    }),
  );
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.ok((await response.text()).startsWith('{"keys":'));
});
test("bounded known transport headers remain distinct from source-owned fields", async () => {
  const oracle = createPlatformWorkosProviderOracle();
  const request = (extra) =>
    new Request("https://api.workos.com/sso/jwks/" + oracle.profile.clientId, {
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        ...extra,
      },
    });
  await oracle.handleRequest(request({}));
  assert.deepEqual([...oracle.platformHeaderNames].sort(), ["cache-control", "pragma"]);
  await assert.rejects(
    oracle.handleRequest(request({ "x-unknown-forwarded": "forbidden" })),
    /PLATFORM_HTTP_ORACLE_REJECTED/,
  );
});
