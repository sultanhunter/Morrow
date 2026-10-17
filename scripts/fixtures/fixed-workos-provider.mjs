import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

// Independent native RSA and HTTP oracle. This file imports no identity/runtime
// implementation. Its URL attestation is synthetic: it proves neither DNS nor TLS.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const fixedProviderEpoch = 1800000000000;
export const fixedProviderId = (prefix, value) => `${prefix}_${String(value).padStart(26, "0")}`;
const base64 = (value) => Buffer.from(value).toString("base64url");
const defaultProfile = () => ({
  schemaVersion: 1,
  providerId: "workos",
  environmentId: fixedProviderId("environment", 1),
  applicationId: fixedProviderId("app", 2),
  clientId: fixedProviderId("client", 3),
  issuer: `https://api.workos.com/user_management/${fixedProviderId("client", 3)}`,
  revision: 1,
  audiencePolicy: "absent",
});
export const fixedProviderPublicJwk = Object.freeze({
  ...publicKey.export({ format: "jwk" }),
  kid: "fixed-provider-independent-rsa-86",
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
});

export function createFixedWorkosProviderOracle(options = {}) {
  const supplied = options.configurationJson && JSON.parse(options.configurationJson);
  const binding = supplied && JSON.parse(supplied.authenticationBindingJson);
  const profile = supplied
    ? JSON.parse(supplied.verificationProfileJson)
    : { ...defaultProfile(), ...options.profile };
  const origin = supplied?.origin ?? options.origin ?? "https://workspace.example.test";
  const authenticationBinding = binding ?? {
    bindingId: "binding_a",
    bindingRevision: 1,
    environmentId: profile.environmentId,
    applicationId: profile.applicationId,
    clientId: profile.clientId,
    redirectUri: origin + "/auth/workos/callback",
    returnPath: "/",
  };
  const authenticationBindingJson = JSON.stringify(authenticationBinding);
  const profileJson = JSON.stringify(profile);
  const configurationJson =
    options.configurationJson ??
    JSON.stringify({
      schemaVersion: 1,
      controllerProtocol: "morrow-login-v1",
      origin,
      retentionTier: "development",
      authenticationBindingJson,
      verificationProfileJson: profileJson,
      profileId: "profile_a",
      profileRecordRevision: 1,
    });
  let current = options.at ?? fixedProviderEpoch;
  const now = options.now ?? (() => current);
  const marker = "synthetic_management_marker_86_only";
  const expectedNamespaceJson = JSON.stringify({
    schemaVersion: 1,
    providerId: "workos",
    environmentId: profile.environmentId,
    applicationId: profile.applicationId,
    clientId: profile.clientId,
    purpose: "list_active_sessions",
  });
  const entries = new Map(),
    calls = [],
    leases = [];
  const metrics = {
    requests: 0,
    exchange: 0,
    publicKeyset: 0,
    sessionPage: 0,
    borrows: 0,
    releaseAttempts: 0,
    releaseCompletions: 0,
    activeLeases: 0,
  };
  const signClaims = (claims, header = {}) => {
    const unsigned =
      base64(
        JSON.stringify({ alg: "RS256", kid: fixedProviderPublicJwk.kid, typ: "JWT", ...header }),
      ) +
      "." +
      base64(JSON.stringify(claims));
    return (
      unsigned +
      "." +
      sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), privateKey).toString("base64url")
    );
  };
  const issueCode = (input) => {
    assert.equal(input.clientId ?? profile.clientId, profile.clientId);
    assert.equal(
      input.redirectUri ?? authenticationBinding.redirectUri,
      authenticationBinding.redirectUri,
    );
    assert.match(input.challenge, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    const at = input.nowMs ?? now();
    const claims = {
      iss: profile.issuer,
      client_id: profile.clientId,
      sub: input.subjectId ?? options.subjectId ?? fixedProviderId("user", 4),
      sid: input.sessionId ?? options.providerSessionId ?? fixedProviderId("session", 5),
      iat: Math.floor(at / 1000) - 5,
      exp: Math.floor(at / 1000) + 120,
    };
    const code = "independent-code-" + randomUUID();
    const token = signClaims(claims);
    entries.set(code, { challenge: input.challenge, claims, token, exchanged: false, at });
    return Object.freeze({ code, token, claims });
  };
  const arm = (authorizationUrl, input = {}) => {
    const url = new URL(authorizationUrl);
    assert.equal(url.origin + url.pathname, "https://api.workos.com/user_management/authorize");
    assert.deepEqual([...url.searchParams.keys()].sort(), [
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "provider",
      "redirect_uri",
      "response_type",
      "state",
    ]);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("provider"), "authkit");
    const issued = issueCode({
      ...input,
      challenge: url.searchParams.get("code_challenge"),
      clientId: url.searchParams.get("client_id"),
      redirectUri: url.searchParams.get("redirect_uri"),
    });
    const callback = new URL(authenticationBinding.redirectUri);
    callback.searchParams.set("code", issued.code);
    callback.searchParams.set("state", url.searchParams.get("state"));
    return Object.freeze({ ...issued, callbackUrl: callback.href });
  };
  const response = (url, text, status = 200, headers = { "Content-Type": "application/json" }) => {
    const result = new Response(text, { status, headers });
    Object.defineProperty(result, "url", { value: url });
    return result;
  };
  const syntheticFetch = async (input, init = {}) => {
    assert.equal(typeof input, "string", "oracle accepts a fixed URL string");
    const url = new URL(input),
      headers = new Headers(init.headers);
    assert.equal(url.origin, "https://api.workos.com");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.has("cookie"), false);
    assert.equal(headers.has("referer"), false);
    let kind, text;
    if (url.pathname === "/user_management/authenticate") {
      kind = "exchange";
      assert.equal(url.search, "");
      assert.equal(init.method, "POST");
      assert.deepEqual([...headers.keys()].sort(), ["accept", "content-type"]);
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(typeof init.body, "string");
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), [
        "client_id",
        "code",
        "code_verifier",
        "grant_type",
      ]);
      assert.equal(body.client_id, profile.clientId);
      assert.equal(body.grant_type, "authorization_code");
      assert.match(body.code_verifier, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
      const entry = entries.get(body.code);
      assert.ok(entry, "code was independently issued");
      assert.equal(entry.exchanged, false, "no code replay");
      assert.equal(
        createHash("sha256").update(body.code_verifier, "ascii").digest("base64url"),
        entry.challenge,
        "S256 proof matches registered authorization",
      );
      entry.exchanged = true;
      text = JSON.stringify({
        access_token: entry.token,
        refresh_token: "synthetic_dropped_refresh_marker",
        user: { id: entry.claims.sub },
        oauth_tokens: { private: "synthetic_dropped_oauth_marker" },
      });
    } else if (url.pathname === `/sso/jwks/${profile.clientId}`) {
      kind = "publicKeyset";
      assert.equal(url.search, "");
      assert.equal(init.method, "GET");
      assert.deepEqual([...headers.keys()], ["accept"]);
      assert.equal(init.body, undefined);
      text = JSON.stringify({ keys: [fixedProviderPublicJwk] });
    } else {
      kind = "sessionPage";
      assert.equal(init.method, "GET");
      assert.deepEqual([...headers.keys()].sort(), ["accept", "authorization"]);
      assert.equal(headers.get("authorization"), "Bearer " + marker);
      assert.equal(init.body, undefined);
      const match = /^\/user_management\/users\/(user_[A-Z0-9]{26})\/sessions$/.exec(url.pathname);
      assert.ok(match);
      assert.deepEqual(
        [...url.searchParams.keys()],
        url.searchParams.has("after") ? ["limit", "order", "after"] : ["limit", "order"],
      );
      assert.equal(url.searchParams.get("limit"), "100");
      assert.equal(url.searchParams.get("order"), "asc");
      assert.ok(
        !url.searchParams.has("after") ||
          /^session_[A-Z0-9]{26}$/.test(url.searchParams.get("after")),
      );
      const unique = new Map();
      for (const entry of entries.values())
        if (entry.exchanged && entry.claims.sub === match[1]) unique.set(entry.claims.sid, entry);
      assert.ok(unique.size > 0, "session lookup follows a valid exchange");
      const rows = [...unique.values()].map((entry) => ({
        object: "session",
        id: entry.claims.sid,
        user_id: entry.claims.sub,
        status: "active",
        auth_method: "oauth",
        ended_at: null,
        created_at: new Date(entry.at - 60000).toISOString(),
        updated_at: new Date(entry.at - 1000).toISOString(),
        expires_at: new Date(entry.at + 60000).toISOString(),
      }));
      text = JSON.stringify({
        object: "list",
        data: rows,
        list_metadata: { before: null, after: null },
      });
    }
    metrics.requests++;
    metrics[kind]++;
    calls.push(
      Object.freeze({ kind, method: init.method, managementMarker: headers.has("authorization") }),
    );
    await options.beforeRequest?.({ kind, signal: init.signal });
    const result = response(url.href, text);
    return (await options.responseFault?.({ kind, response: result, url: url.href })) ?? result;
  };
  const broker = {
    async borrow(selectorJson, control) {
      assert.equal(selectorJson, expectedNamespaceJson);
      assert.ok(control.signal instanceof AbortSignal);
      assert.equal(control.signal.aborted, false);
      assert.ok(control.deadlineMs > now());
      metrics.borrows++;
      const revocation = new AbortController();
      let released = false;
      const lease = {
        namespaceJson: expectedNamespaceJson,
        credential: marker,
        expiresAtMs: now() + 60000,
        revocationSignal: revocation.signal,
        async release(releaseControl) {
          metrics.releaseAttempts++;
          assert.equal(released, false, "lease release is invoked once");
          released = true;
          assert.ok(releaseControl.signal instanceof AbortSignal);
          assert.ok(releaseControl.deadlineMs > now());
          await options.beforeRelease?.({ control: releaseControl });
          metrics.releaseCompletions++;
          metrics.activeLeases--;
        },
      };
      leases.push({ lease, revoke: () => revocation.abort() });
      metrics.activeLeases++;
      await options.beforeBorrowReturn?.({ lease, control });
      return lease;
    },
  };
  return {
    at: current,
    profile,
    profileJson,
    configurationJson,
    authenticationBindingJson,
    now,
    setTime(value) {
      current = value;
    },
    issueCode,
    arm,
    sign: signClaims,
    syntheticFetch,
    fetch: syntheticFetch,
    broker,
    sessionCredentialBroker: broker,
    metrics,
    calls,
    leases,
    expectedNamespaceJson,
    publicJwk: fixedProviderPublicJwk,
    response,
    secrets: [marker, "synthetic_dropped_refresh_marker", "synthetic_dropped_oauth_marker"],
  };
}
export const buildFixedWorkosProviderOracle = createFixedWorkosProviderOracle;
