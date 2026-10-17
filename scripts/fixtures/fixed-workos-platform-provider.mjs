import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createFixedWorkosProviderOracle } from "./fixed-workos-provider.mjs";

// Native HTTP boundary oracle. Reuse independent RSA/configuration/issuance only;
// never call the86 synthetic Fetch or manufacture Response URL attributes.
export function createPlatformWorkosProviderOracle(options = {}) {
  const crypto = createFixedWorkosProviderOracle(options);
  const configuration = JSON.parse(crypto.configurationJson);
  const binding = JSON.parse(configuration.authenticationBindingJson);
  const codes = new Map(),
    sessions = new Map();
  const metrics = {
    interceptedRequests: 0,
    exchange: 0,
    publicKeyset: 0,
    sessionPage: 0,
    oracleFailures: 0,
    delayedRepliesCompleted: 0,
    remoteStreamCancelAttempts: 0,
    activeResponseTimers: 0,
    streamCompletionAttempts: 0,
    actualInternetRequests: 0,
    actualProviderRequests: 0,
  };
  const calls = [],
    platformHeaderNames = new Set(),
    secrets = [...crypto.secrets];
  const register = (issued, challenge) => {
    assert.match(challenge, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    codes.set(issued.code, { ...issued, challenge, used: false });
    secrets.push(issued.code, issued.token, issued.claims.sub, issued.claims.sid);
    return issued;
  };
  const issueAuthorization = (input) => register(crypto.issueCode(input), input.challenge);
  const arm = (url) => {
    const authorization = new URL(url);
    assert.equal(authorization.username + authorization.password + authorization.hash, "");
    // arm independently validates the seven authorization fields and client/callback.
    return register(crypto.arm(url), authorization.searchParams.get("code_challenge"));
  };
  const activate = (issued) => {
    sessions.set(issued.claims.sid, { claims: issued.claims, at: crypto.now() });
  };
  const fault = options.fault ?? {};
  const handleRequest = async (request) => {
    metrics.interceptedRequests++;
    try {
      const url = new URL(request.url),
        headers = request.headers;
      assert.equal(url.origin, "https://api.workos.com");
      assert.equal(url.username + url.password + url.hash, "");
      assert.equal(headers.get("accept"), "application/json");
      for (const name of ["cookie", "referer", "proxy-authorization", "x-api-key"])
        assert.equal(headers.has(name), false, "forbidden header");
      let kind, text;
      if (url.pathname === "/user_management/authenticate") {
        kind = "exchange";
        assert.equal(request.method, "POST");
        assert.equal(url.search, "");
        assert.equal(headers.get("content-type"), "application/json");
        assert.equal(headers.has("authorization"), false);
        const raw = await request.text();
        assert.ok(Buffer.byteLength(raw) <= 32768);
        const body = JSON.parse(raw);
        assert.equal(JSON.stringify(body), raw, "canonical four-field JSON without duplicates");
        assert.deepEqual(Object.keys(body).sort(), [
          "client_id",
          "code",
          "code_verifier",
          "grant_type",
        ]);
        assert.equal(body.client_id, crypto.profile.clientId);
        assert.equal(body.grant_type, "authorization_code");
        assert.match(body.code_verifier, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
        const registered = codes.get(body.code);
        assert.ok(registered, "authorization registered before POST");
        assert.equal(registered.used, false, "code exchanged once");
        assert.equal(
          createHash("sha256").update(body.code_verifier, "ascii").digest("base64url"),
          registered.challenge,
        );
        registered.used = true;
        activate(registered);
        text = JSON.stringify({
          access_token: registered.token,
          refresh_token: "platform_dropped_refresh_marker",
          user: { id: registered.claims.sub },
        });
      } else if (url.pathname === `/sso/jwks/${crypto.profile.clientId}`) {
        kind = "publicKeyset";
        assert.equal(request.method, "GET");
        assert.equal(url.search, "");
        assert.equal(headers.has("authorization"), false);
        assert.equal(headers.has("content-type"), false);
        assert.equal(await request.text(), "");
        text = JSON.stringify({ keys: [crypto.publicJwk] });
      } else {
        kind = "sessionPage";
        const match = /^\/user_management\/users\/(user_[A-Z0-9]{26})\/sessions$/.exec(
          url.pathname,
        );
        assert.ok(match, "only fixed session path");
        assert.equal(request.method, "GET");
        assert.equal(headers.get("authorization"), "Bearer platform_management_marker_87_only");
        assert.equal(headers.has("content-type"), false);
        assert.equal(await request.text(), "");
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
        const rows = [...sessions.values()]
          .filter((entry) => entry.claims.sub === match[1])
          .map((entry) => ({
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
        assert.ok(rows.length > 0, "independent active catalogue");
        text = JSON.stringify({
          object: "list",
          data: rows,
          list_metadata: { before: null, after: null },
        });
      }
      const owned = new Set([
        "accept",
        ...(kind === "exchange" ? ["content-type"] : []),
        ...(kind === "sessionPage" ? ["authorization"] : []),
      ]);
      const platform = new Set([
        "cache-control",
        "pragma",
        "cf-worker",
        "host",
        "content-length",
        "accept-encoding",
        "user-agent",
      ]);
      for (const [name, value] of headers) {
        if (owned.has(name)) continue;
        assert.ok(platform.has(name), "unrecognized platform header name");
        platformHeaderNames.add(name);
        if (name === "cache-control" || name === "pragma") assert.equal(value, "no-cache");
        if (name === "host") assert.equal(value, "api.workos.com");
        if (name === "content-length") assert.match(value, /^(0|[1-9][0-9]*)$/);
      }
      metrics[kind]++;
      calls.push({ kind, method: request.method, managementMarker: headers.has("authorization") });
      const applies = !fault.kind || fault.kind === kind;
      let status = 200;
      const replyHeaders = { "Content-Type": "application/json" };
      if (applies) {
        if (fault.delayMs) {
          metrics.activeResponseTimers++;
          await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
          metrics.activeResponseTimers--;
          metrics.delayedRepliesCompleted++;
        }
        if (fault.status) status = fault.status;
        if (status >= 300 && status <= 399)
          replyHeaders.Location = fault.foreign
            ? "https://foreign.invalid/never-follow"
            : "https://api.workos.com/never-follow";
        if (status === 429) replyHeaders["Retry-After"] = "0";
        if (fault.name === "media")
          replyHeaders["Content-Type"] = "application/json; charset=utf-8; other=forbidden";
        if (fault.name === "duplicate")
          text =
            kind === "exchange"
              ? '{"access_token":"a.b.c","access_token":"d.e.f"}'
              : kind === "publicKeyset"
                ? '{"keys":[],"keys":[]}'
                : '{"object":"list","object":"list"}';
        if (fault.name === "bom") text = "\uFEFF" + text;
        if (fault.name === "utf8") text = new Uint8Array([255]);
        if (fault.name === "oversize" || fault.name === "gzip_oversize") text = " ".repeat(131073);
        if (fault.name === "private_jwk")
          text = JSON.stringify({ keys: [{ ...crypto.publicJwk, d: "private-material" }] });
        if (fault.name === "keys17")
          text = JSON.stringify({ keys: Array.from({ length: 17 }, () => crypto.publicJwk) });
        if (fault.name === "declared_size") replyHeaders["Content-Length"] = "131073";
        if (fault.name === "gzip" || fault.name === "gzip_oversize")
          replyHeaders["Content-Encoding"] = "gzip";
        if (fault.name === "stream_late") {
          const bytes = new TextEncoder().encode(text);
          text = new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 1));
              metrics.activeResponseTimers++;
              setTimeout(() => {
                metrics.activeResponseTimers--;
                metrics.streamCompletionAttempts++;
                try {
                  controller.enqueue(bytes.slice(1));
                  controller.close();
                } catch {
                  /* Remote cancellation is distinct from Worker acknowledgement. */
                }
              }, 100);
            },
            cancel() {
              metrics.remoteStreamCancelAttempts++;
            },
          });
        }
      }
      return new Response(text, { status, headers: replyHeaders });
    } catch {
      metrics.oracleFailures++;
      throw Error("PLATFORM_HTTP_ORACLE_REJECTED");
    }
  };
  return {
    configurationJson: crypto.configurationJson,
    profile: crypto.profile,
    profileJson: crypto.profileJson,
    authenticationBindingJson: crypto.authenticationBindingJson,
    publicJwk: crypto.publicJwk,
    now: crypto.now,
    at: crypto.at,
    issueAuthorization,
    arm,
    activate,
    handleRequest,
    metrics,
    calls,
    platformHeaderNames,
    secrets,
    marker: "platform_management_marker_87_only",
    callback: binding.redirectUri,
  };
}
