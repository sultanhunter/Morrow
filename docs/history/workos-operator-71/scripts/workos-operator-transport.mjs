// Scripts-only operator adapter. No merchant caller, identity issuer or SDK.
const nativeFetch = globalThis.fetch.bind(globalThis);
const fixedProfile = Object.freeze({
  schema_version: 1,
  plan_sequence: 71,
  provider_id: "workos",
  environment_kind: "staging",
  environment_id: "environment_01M4HG7FV7X8EFXE1J9S6GG00R",
  application_id: "app_01M4HG7GEJJWTKG4W16RB98VZE",
  client_id: "client_01M4HG7GA0DX8C3PFSQHBP4BN3",
  binding_id: "workos_operator_staging",
  binding_revision: 1,
  origin: "http://127.0.0.1:4110",
  start_path: "/operator/workos/start",
  callback_path: "/operator/workos/callback",
  result_path: "/operator/workos/result",
  return_path: "/operator/workos/result",
  authorize_endpoint: "https://api.workos.com/user_management/authorize",
  token_endpoint: "https://api.workos.com/user_management/authenticate",
  max_flow_seconds: 300,
  max_post_seconds: 15,
  max_response_bytes: 131072,
  max_code_units: 4096,
  max_invalid_requests: 20,
  max_body_bytes: 1024,
  max_uri_bytes: 65536,
  max_header_bytes: 98304,
  max_posts: 1,
  max_initiations: 1,
  keyless_only: true,
  merchant_routes_enabled: false,
  actual_provider_status: "awaiting_owner_activation",
});
const deny = () => Error("WORKOS_OPERATOR_TRANSPORT_DENIED");
export function parseWorkosOperatorProfile(value) {
  if (typeof value !== "string" || value.length > 8192) throw deny();
  try {
    const profile = JSON.parse(value);
    if (
      !profile ||
      Array.isArray(profile) ||
      typeof profile !== "object" ||
      Object.keys(profile).sort().join(",") !== Object.keys(fixedProfile).sort().join(",") ||
      Object.entries(fixedProfile).some(([key, expected]) => profile[key] !== expected)
    )
      throw deny();
    return Object.freeze(profile);
  } catch {
    throw deny();
  }
}
const observation = (category, statusClass = null) =>
  Object.freeze({
    outcome: category === "response_shape_received" ? "response_shape_received" : "held",
    category,
    statusClass,
    providerSessionCleanup: "unknown",
  });
export function workosOperatorEnvironmentAllowed() {
  return (
    (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "1") &&
    !Object.keys(process.env).some(
      (key) =>
        /^WORKOS_/i.test(key) ||
        /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|NODE_OPTIONS|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(
          key,
        ),
    )
  );
}
function pairedUtf16(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function privateInput(value) {
  if (typeof value !== "string" || value.length > 32768) throw deny();
  const p = JSON.parse(value);
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).sort().join(",") !== "code,verifier" ||
    typeof p.code !== "string" ||
    !p.code.length ||
    p.code.length > 4096 ||
    !pairedUtf16(p.code) ||
    typeof p.verifier !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(p.verifier) ||
    Buffer.from(p.verifier, "base64url").toString("base64url") !== p.verifier
  )
    throw deny();
  return Object.freeze(p);
}
function cancel(body) {
  try {
    void body?.cancel().catch(() => {});
  } catch {
    /* No diagnostic failure or disposal wait. */
  }
}
const coarseStatus = (status) =>
  Number.isInteger(status) && status >= 200 && status <= 599
    ? `${Math.floor(status / 100)}xx`
    : null;

export function createWorkosOperatorTransport(profileJson, options) {
  const profile = parseWorkosOperatorProfile(profileJson);
  if (
    !options ||
    !["synthetic", "native"].includes(options.mode) ||
    Object.keys(options).some((key) => !["mode", "fetch", "clock"].includes(key)) ||
    (options.mode === "synthetic" && typeof options.fetch !== "function") ||
    (options.mode === "native" &&
      (Object.hasOwn(options, "fetch") || Object.hasOwn(options, "clock")))
  )
    throw deny();
  const mode = options.mode,
    fetcher = mode === "native" ? nativeFetch : options.fetch,
    clock = options.clock ?? Date.now;
  let used = false;
  return Object.freeze({
    mode,
    async exchangeOnce(value, control = {}) {
      if (used) return observation("already_used");
      used = true;
      let input;
      try {
        input = privateInput(value);
      } catch {
        return observation("input_denied");
      }
      if (!workosOperatorEnvironmentAllowed()) return observation("configuration_denied");
      let milliseconds, signal;
      try {
        const now = clock();
        signal = control.signal;
        if (!Number.isFinite(now) || (signal !== undefined && !(signal instanceof AbortSignal)))
          return observation("configuration_denied");
        milliseconds = Math.min(
          profile.max_post_seconds * 1000,
          control.deadlineMs === undefined ? 15000 : control.deadlineMs - now,
        );
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) return observation("timeout");
        if (signal?.aborted) return observation("cancelled");
      } catch {
        return observation("configuration_denied");
      }
      const aborter = new AbortController();
      let finished = false,
        timer,
        finish,
        activeReader,
        activeBody;
      const interrupted = new Promise((resolve) => {
        finish = resolve;
      });
      const abort = () => {
        aborter.abort();
        finish(observation("cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        aborter.abort();
        finish(observation("timeout"));
      }, milliseconds);
      const request = async () => {
        let response,
          reader,
          statusClass = null,
          category = "transport_failed";
        try {
          if (!workosOperatorEnvironmentAllowed()) return observation("configuration_denied");
          // No headers, cookies, client secret, proxy configuration or URL is caller-supplied.
          response = await fetcher(profile.token_endpoint, {
            method: "POST",
            redirect: "error",
            signal: aborter.signal,
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              client_id: profile.client_id,
              grant_type: "authorization_code",
              code: input.code,
              code_verifier: input.verifier,
            }),
          });
          activeBody = response?.body;
          if (finished || aborter.signal.aborted) {
            cancel(response?.body);
            return observation("cancelled");
          }
          if (!(response instanceof Response)) return observation("shape_denied");
          if (response.url !== profile.token_endpoint || response.redirected) {
            cancel(response.body);
            return observation("response_origin_denied");
          }
          statusClass = coarseStatus(response.status);
          if (response.status !== 200) {
            cancel(response.body);
            return observation("http_rejected", statusClass);
          }
          const contentType = response.headers.get("content-type");
          if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
            cancel(response.body);
            return observation("content_denied", statusClass);
          }
          const declared = response.headers.get("content-length");
          if (
            declared !== null &&
            (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > profile.max_response_bytes)
          ) {
            cancel(response.body);
            return observation("body_denied", statusClass);
          }
          if (!response.body) return observation("shape_denied", statusClass);
          reader = response.body.getReader();
          activeReader = reader;
          category = "body_denied";
          const chunks = [];
          let bytes = 0;
          while (true) {
            const part = await reader.read();
            if (finished || aborter.signal.aborted) {
              try {
                void reader.cancel().catch(() => {});
              } catch {}
              return observation("cancelled", statusClass);
            }
            if (part.done) break;
            if (
              !(part.value instanceof Uint8Array) ||
              (bytes += part.value.byteLength) > profile.max_response_bytes
            ) {
              try {
                void reader.cancel().catch(() => {});
              } catch {}
              return observation("body_denied", statusClass);
            }
            chunks.push(part.value);
          }
          category = "shape_denied";
          const joined = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) {
            joined.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
          if (
            !data ||
            typeof data !== "object" ||
            Array.isArray(data) ||
            typeof data.access_token !== "string" ||
            !data.access_token.length ||
            data.access_token.length > 65536 ||
            typeof data.refresh_token !== "string" ||
            !data.refresh_token.length ||
            data.refresh_token.length > 65536 ||
            !data.user ||
            typeof data.user !== "object" ||
            Array.isArray(data.user) ||
            typeof data.user.id !== "string" ||
            !/^user_[A-Z0-9]{26}$/.test(data.user.id)
          )
            return observation("shape_denied", statusClass);
          // Token/user values never leave this scope. No JWT is decoded or trusted.
          return observation("response_shape_received", statusClass);
        } catch {
          return observation(category, statusClass);
        } finally {
          if (reader)
            try {
              reader.releaseLock();
            } catch {}
        }
      };
      try {
        return await Promise.race([request(), interrupted]);
      } finally {
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        aborter.abort();
        if (activeReader)
          try {
            void activeReader.cancel().catch(() => {});
          } catch {}
        else cancel(activeBody);
      }
    },
  });
}
