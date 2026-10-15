// Scripts-only single-attempt adapter. Sensitive provider values never leave it.
import { parseWorkosOperatorJson } from "./workos-operator-json.mjs";
import { createWorkosSessionTokenVerifier } from "../packages/identity/src/workos-session-token.ts";
const nativeFetch = globalThis.fetch.bind(globalThis);
const fixedProfile = Object.freeze({
  schema_version: 1,
  plan_sequence: 74,
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
  issuer: "https://api.workos.com/user_management/client_01M4HG7GA0DX8C3PFSQHBP4BN3",
  jwks_endpoint: "https://api.workos.com/sso/jwks/client_01M4HG7GA0DX8C3PFSQHBP4BN3",
  max_jwks_reads: 1,
  max_jwks_response_bytes: 65536,
});
const deny = () => Error("WORKOS_OPERATOR_TRANSPORT_DENIED");
export function parseWorkosOperatorProfile(value) {
  try {
    const profile = parseWorkosOperatorJson(value, 8192);
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
    outcome: category === "cryptographically_verified_candidate" ? category : "held",
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
function projectedPublicJwks(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "keys" ||
    !Array.isArray(value.keys) ||
    !value.keys.length ||
    value.keys.length > 16
  )
    throw deny();
  const verifierFields = ["kty", "kid", "n", "e", "alg", "use", "key_ops"];
  const allowed = [...verifierFields, "x5c", "x5t#S256"];
  return {
    keys: value.keys.map((key) => {
      if (
        !key ||
        typeof key !== "object" ||
        Array.isArray(key) ||
        Object.keys(key).some((name) => !allowed.includes(name))
      )
        throw deny();
      if (Object.hasOwn(key, "x5c")) {
        if (!Array.isArray(key.x5c) || key.x5c.length < 1 || key.x5c.length > 4) throw deny();
        let total = 0;
        for (const certificate of key.x5c) {
          if (
            typeof certificate !== "string" ||
            !certificate.length ||
            certificate.length > 10924 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(certificate)
          )
            throw deny();
          const bytes = Buffer.from(certificate, "base64");
          if (
            !bytes.length ||
            bytes.length > 8192 ||
            bytes.toString("base64") !== certificate ||
            (total += bytes.length) > 16384
          )
            throw deny();
        }
      }
      if (Object.hasOwn(key, "x5t#S256")) {
        const thumbprint = key["x5t#S256"];
        if (typeof thumbprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(thumbprint)) throw deny();
        const bytes = Buffer.from(thumbprint, "base64url");
        if (bytes.length !== 32 || bytes.toString("base64url") !== thumbprint) throw deny();
      }
      // Encoding checks do not establish PKI trust. Only these two observed
      // metadata members are discarded; the verifier receives key values unchanged.
      const projected = {};
      for (const name of verifierFields) if (Object.hasOwn(key, name)) projected[name] = key[name];
      return projected;
    }),
  };
}
function privateInput(value) {
  const p = parseWorkosOperatorJson(value, 32768);
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).sort().join(",") !== "code,verifier" ||
    typeof p.code !== "string" ||
    !p.code.length ||
    p.code.length > 4096 ||
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
    /* Disposal is never awaited. */
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
      (Object.hasOwn(options, "fetch") || Object.hasOwn(options, "clock"))) ||
    (Object.hasOwn(options, "clock") && typeof options.clock !== "function")
  )
    throw deny();
  const mode = options.mode,
    fetcher = mode === "native" ? nativeFetch : options.fetch,
    clock = options.clock ?? Date.now;
  const verificationProfile = JSON.stringify({
    schemaVersion: 1,
    providerId: "workos",
    environmentId: profile.environment_id,
    applicationId: profile.application_id,
    clientId: profile.client_id,
    issuer: profile.issuer,
    revision: profile.binding_revision,
    audiencePolicy: "absent",
  });
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
      let signal, beforePost, openedAt, endAt;
      try {
        signal = control.signal;
        beforePost = control.beforePost;
        openedAt = clock();
        if (typeof beforePost !== "function") return observation("before_post_denied");
        if (
          !Number.isSafeInteger(openedAt) ||
          openedAt < 0 ||
          (signal !== undefined && !(signal instanceof AbortSignal))
        )
          return observation("configuration_denied");
        endAt = Math.min(
          openedAt + profile.max_post_seconds * 1000,
          control.deadlineMs === undefined ? openedAt + 15000 : control.deadlineMs,
        );
        if (!Number.isSafeInteger(endAt) || endAt <= openedAt) return observation("timeout");
        if (signal?.aborted) return observation("cancelled");
      } catch {
        return observation("configuration_denied");
      }
      const aborter = new AbortController();
      let finished = false,
        lastClock = openedAt,
        activeReader,
        activeBody,
        interruptCategory = null,
        finish;
      const interrupted = new Promise((resolve) => {
        finish = resolve;
      });
      const interrupt = (category) => {
        interruptCategory = category;
        aborter.abort();
        finish(observation(category));
      };
      const abort = () => interrupt("cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => interrupt("timeout"), endAt - openedAt);
      const check = () => {
        if (finished || aborter.signal.aborted) return interruptCategory ?? "cancelled";
        if (!workosOperatorEnvironmentAllowed()) return "configuration_denied";
        const now = clock();
        if (!Number.isSafeInteger(now) || now < lastClock) return "configuration_denied";
        lastClock = now;
        if (!workosOperatorEnvironmentAllowed()) return "configuration_denied";
        if (finished || aborter.signal.aborted) return interruptCategory ?? "cancelled";
        return now >= endAt ? "timeout" : null;
      };
      const request = async () => {
        let category = "transport_failed",
          statusClass = null;
        const checked = () => {
          const error = check();
          if (error) {
            category = error;
            throw deny();
          }
        };
        const readJson = async (url, method, cap, body) => {
          checked();
          category = "transport_failed";
          statusClass = null;
          const response = await fetcher(url, {
            method,
            redirect: "error",
            credentials: "omit",
            signal: aborter.signal,
            headers:
              method === "POST"
                ? { "content-type": "application/json", accept: "application/json" }
                : { accept: "application/json" },
            ...(body === undefined ? {} : { body }),
          });
          if (!(response instanceof Response)) {
            category = "shape_denied";
            throw deny();
          }
          activeBody = response.body;
          try {
            checked();
          } catch {
            // The outer timeout may already have disposed its then-known body.
            // A response arriving later still owns a body that must be canceled.
            cancel(response.body);
            throw deny();
          }
          if (response.url !== url || response.redirected) {
            category = "response_origin_denied";
            cancel(response.body);
            throw deny();
          }
          statusClass = coarseStatus(response.status);
          if (response.status !== 200) {
            category = "http_rejected";
            cancel(response.body);
            throw deny();
          }
          const type = response.headers.get("content-type");
          if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
            category = "content_denied";
            cancel(response.body);
            throw deny();
          }
          const length = response.headers.get("content-length");
          if (length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > cap)) {
            category = "body_denied";
            cancel(response.body);
            throw deny();
          }
          if (!response.body) {
            category = "shape_denied";
            throw deny();
          }
          const reader = response.body.getReader();
          activeReader = reader;
          category = "body_denied";
          try {
            const chunks = [];
            let bytes = 0;
            while (true) {
              const part = await reader.read();
              checked();
              if (part.done) break;
              if (!(part.value instanceof Uint8Array) || (bytes += part.value.byteLength) > cap) {
                void reader.cancel().catch(() => {});
                throw deny();
              }
              chunks.push(part.value);
            }
            const joined = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) {
              joined.set(chunk, offset);
              offset += chunk.byteLength;
            }
            category = "shape_denied";
            return parseWorkosOperatorJson(
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(joined),
              cap,
            );
          } finally {
            try {
              reader.releaseLock();
            } catch {}
            activeReader = undefined;
          }
        };
        try {
          const jwks = projectedPublicJwks(
            await readJson(profile.jwks_endpoint, "GET", profile.max_jwks_response_bytes),
          );
          checked();
          const observedAtMs = clock();
          const verifier = createWorkosSessionTokenVerifier(
            verificationProfile,
            JSON.stringify({
              schemaVersion: 1,
              profileRevision: profile.binding_revision,
              environmentId: profile.environment_id,
              applicationId: profile.application_id,
              clientId: profile.client_id,
              observedAtMs,
              expiresAtMs: observedAtMs + 300000,
              jwks,
            }),
            clock,
          );
          category = "before_post_denied";
          if ((await beforePost()) !== true) throw deny();
          checked();
          const data = await readJson(
            profile.token_endpoint,
            "POST",
            profile.max_response_bytes,
            JSON.stringify({
              client_id: profile.client_id,
              grant_type: "authorization_code",
              code: input.code,
              code_verifier: input.verifier,
            }),
          );
          if (
            !data ||
            typeof data !== "object" ||
            Array.isArray(data) ||
            typeof data.access_token !== "string" ||
            !data.access_token.length ||
            data.access_token.length > 16384 ||
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
          checked();
          category = "token_denied";
          const verified = await verifier.verify(data.access_token);
          checked();
          const candidate =
            verified.outcome === "verified" ? verifier.readCandidate(verified.handle) : null;
          if (!candidate || candidate.subjectId !== data.user.id)
            return observation("token_denied", statusClass);
          checked();
          return observation("cryptographically_verified_candidate", statusClass);
        } catch {
          return observation(category, statusClass);
        }
      };
      try {
        return await Promise.race([request(), interrupted]);
      } finally {
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        aborter.abort();
        if (activeReader) {
          try {
            void activeReader.cancel().catch(() => {});
          } catch {}
        } else cancel(activeBody);
      }
    },
  });
}
