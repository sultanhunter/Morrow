// Maintained scripts-only operator. Provider secrets and domain handles stay here.
import { consumeWorkosAuthenticationOperatorNativePermit } from "./workos-authentication-operator-input.mjs";
import { createWorkosSessionTokenVerifier } from "../packages/identity/src/workos-session-token.ts";
import { createWorkosAuthenticationEvidence } from "../packages/identity/src/workos-authentication-evidence.ts";
import { parseWorkosSessionStatusJson } from "../packages/identity/src/workos-session-status-json.ts";

const nativeFetch = globalThis.fetch.bind(globalThis);
const fail = () => Error("WORKOS_AUTHENTICATION_OPERATOR_NATIVE_HELD");
const integer = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
const statusClass = (n) =>
  Number.isInteger(n) && n >= 200 && n <= 599 ? `${Math.floor(n / 100)}xx` : null;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) =>
  object(value) && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const sessionId = (value) =>
  typeof value === "string" && /^session_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
function environmentAllowed() {
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
function dispose(body) {
  try {
    void body?.cancel().catch(() => {});
  } catch {
    /* Never wait on disposal. */
  }
}
function secret(value) {
  const parsed = parseWorkosSessionStatusJson(value, 32768);
  if (
    !keys(parsed, ["code", "verifier"]) ||
    typeof parsed.code !== "string" ||
    !parsed.code.length ||
    parsed.code.length > 4096 ||
    typeof parsed.verifier !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.verifier) ||
    Buffer.from(parsed.verifier, "base64url").length !== 32 ||
    Buffer.from(parsed.verifier, "base64url").toString("base64url") !== parsed.verifier
  )
    throw fail();
  return parsed;
}
function projectJwks(value) {
  if (
    !keys(value, ["keys"]) ||
    !Array.isArray(value.keys) ||
    !value.keys.length ||
    value.keys.length > 16
  )
    throw fail();
  const base = ["kty", "kid", "n", "e", "alg", "use", "key_ops"];
  return {
    keys: value.keys.map((key) => {
      if (
        !object(key) ||
        Object.keys(key).some((name) => ![...base, "x5c", "x5t#S256"].includes(name))
      )
        throw fail();
      if (Object.hasOwn(key, "x5c")) {
        if (!Array.isArray(key.x5c) || key.x5c.length < 1 || key.x5c.length > 4) throw fail();
        let total = 0;
        for (const certificate of key.x5c) {
          if (
            typeof certificate !== "string" ||
            !certificate.length ||
            certificate.length > 10924 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(certificate)
          )
            throw fail();
          const bytes = Buffer.from(certificate, "base64");
          if (
            !bytes.length ||
            bytes.length > 8192 ||
            bytes.toString("base64") !== certificate ||
            (total += bytes.length) > 16384
          )
            throw fail();
        }
      }
      if (Object.hasOwn(key, "x5t#S256")) {
        const thumb = key["x5t#S256"];
        if (
          typeof thumb !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(thumb) ||
          Buffer.from(thumb, "base64url").length !== 32 ||
          Buffer.from(thumb, "base64url").toString("base64url") !== thumb
        )
          throw fail();
      }
      // Certificate metadata is encoding-checked, never trusted as PKI authority.
      return Object.fromEntries(
        base.filter((name) => Object.hasOwn(key, name)).map((name) => [name, key[name]]),
      );
    }),
  };
}
function create(permit, mode, fetcher, clock) {
  let context;
  try {
    context = consumeWorkosAuthenticationOperatorNativePermit(permit);
    if (context.mode !== mode || typeof fetcher !== "function" || typeof clock !== "function")
      throw fail();
  } catch {
    throw fail();
  }
  const binding = context.binding;
  const issuer = `https://api.workos.com/user_management/${binding.clientId}`;
  const jwksUrl = `https://api.workos.com/sso/jwks/${binding.clientId}`;
  const postUrl = "https://api.workos.com/user_management/authenticate";
  const verificationProfile = JSON.stringify({
    schemaVersion: 1,
    providerId: "workos",
    environmentId: binding.environmentId,
    applicationId: binding.applicationId,
    clientId: binding.clientId,
    issuer,
    revision: context.profile.bindingRevision,
    audiencePolicy: "absent",
  });
  let used = false,
    closed = false,
    activeInterrupt;
  const result = (category, counts, observedStatus = null, success = false) =>
    Object.freeze({
      outcome: success ? "verified_active_evidence" : "held",
      category,
      statusClass: observedStatus,
      ...counts,
      tokenProvenance: success ? "signature_verified" : null,
      sessionClientBinding: success ? "expected_only" : null,
      sessionLiveness: success ? "not_guaranteed" : null,
      providerSessionCleanup: "unknown",
    });
  return Object.freeze({
    mode,
    completeOnce(value, control = {}) {
      const counts = { jwksGetCount: 0, codePostCount: 0, sessionGetCount: 0 };
      if (used || closed) return Promise.resolve(result("already_used", counts));
      used = true;
      let input, start, lastClock, signal, callbacks, phaseEnd, totalEnd;
      try {
        start = clock();
        if (!integer(start)) throw fail();
        input = secret(value);
        signal = control.signal;
        callbacks = Object.fromEntries(
          [
            "beforeJwks",
            "beforePost",
            "beforePage",
            "onVerifiedTarget",
            "onEvidenceObservation",
          ].map((name) => [name, control[name]]),
        );
        if (
          Object.values(callbacks).some((fn) => typeof fn !== "function") ||
          !(signal instanceof AbortSignal) ||
          !integer(control.deadlineMs)
        )
          throw fail();
        if (!environmentAllowed()) return Promise.resolve(result("configuration_denied", counts));
        if (context.current() !== true) throw fail();
        lastClock = clock();
        if (!integer(lastClock) || lastClock < start) throw fail();
        totalEnd = Math.min(
          start + 25000,
          control.deadlineMs,
          context.expiresAtMs,
          context.credentialExpiresAtMs,
        );
        phaseEnd = Math.min(start + 15000, totalEnd);
        if (!integer(totalEnd) || !integer(phaseEnd) || phaseEnd <= lastClock)
          return Promise.resolve(result("timeout", counts));
        if (signal.aborted) return Promise.resolve(result("cancelled", counts));
      } catch {
        return Promise.resolve(result("input_denied", counts));
      }
      const abort = new AbortController();
      let finished = false,
        category = "transport_failed",
        observedStatus = null,
        timer,
        interruptResolve,
        interruptCategory,
        activeReader,
        activeBody,
        token,
        snapshotJson,
        candidate,
        observationWritten = false;
      const interrupted = new Promise((resolve) => {
        interruptResolve = resolve;
      });
      const interrupt = (reason) => {
        if (finished || interruptCategory) return;
        interruptCategory = reason;
        abort.abort();
        interruptResolve(result(reason, counts, observedStatus));
      };
      activeInterrupt = interrupt;
      const externalAbort = () => interrupt("cancelled");
      signal.addEventListener("abort", externalAbort, { once: true });
      const tick = () => {
        const at = clock();
        if (!integer(at) || at < lastClock) {
          category = "source_denied";
          throw fail();
        }
        lastClock = at;
        return at;
      };
      const checked = () => {
        if (finished || closed || abort.signal.aborted || signal.aborted) {
          category = interruptCategory ?? "cancelled";
          throw fail();
        }
        if (!environmentAllowed()) {
          category = "configuration_denied";
          throw fail();
        }
        tick();
        let current;
        try {
          current = context?.current();
        } catch {
          category = "source_denied";
          throw fail();
        }
        const at = tick();
        if (current !== true) {
          category = "source_denied";
          throw fail();
        }
        if (finished || closed || abort.signal.aborted || signal.aborted) {
          category = interruptCategory ?? "cancelled";
          throw fail();
        }
        if (!environmentAllowed()) {
          category = "configuration_denied";
          throw fail();
        }
        if (at >= phaseEnd || at >= totalEnd) {
          category = "timeout";
          throw fail();
        }
        return at;
      };
      const arm = () => {
        clearTimeout(timer);
        const at = checked();
        timer = setTimeout(() => interrupt("timeout"), phaseEnd - at);
      };
      const callback = async (name, args, denied) => {
        checked();
        category = denied;
        const response = await callbacks[name](...args);
        checked();
        if (response !== true) {
          category = denied;
          throw fail();
        }
      };
      const readJson = async (url, method, cap, body, authorization) => {
        checked();
        category = "transport_failed";
        let response, reader, responseBody;
        try {
          const headers = { accept: "application/json" };
          if (method === "POST") headers["content-type"] = "application/json";
          if (authorization !== undefined) headers.authorization = `Bearer ${authorization}`;
          if (url === jwksUrl) counts.jwksGetCount++;
          else if (method === "POST") counts.codePostCount++;
          else counts.sessionGetCount++;
          observedStatus = null;
          response = await fetcher(url, {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal: abort.signal,
          });
          // A response may settle after the outer timeout already disposed its
          // resources. This local finally also cancels such a late body.
          responseBody = response?.body;
          checked();
          if (!(response instanceof Response) || response.url !== url || response.redirected) {
            category = "response_origin_denied";
            throw fail();
          }
          observedStatus = statusClass(response.status);
          if (response.status !== 200) {
            category = "http_rejected";
            throw fail();
          }
          if (
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              response.headers.get("content-type") ?? "",
            )
          ) {
            category = "content_denied";
            throw fail();
          }
          const declared = response.headers.get("content-length");
          if (
            declared !== null &&
            (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > cap)
          ) {
            category = "body_denied";
            throw fail();
          }
          if (!responseBody) {
            category = "body_denied";
            throw fail();
          }
          activeBody = responseBody;
          reader = responseBody.getReader();
          activeReader = reader;
          const chunks = [];
          let length = 0;
          for (;;) {
            checked();
            const chunk = await reader.read();
            checked();
            if (chunk.done) break;
            if (!(chunk.value instanceof Uint8Array) || (length += chunk.value.byteLength) > cap) {
              category = "body_denied";
              throw fail();
            }
            chunks.push(chunk.value);
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          category = "body_denied";
          const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          const parsed = parseWorkosSessionStatusJson(raw, cap);
          checked();
          return { parsed, raw, length };
        } finally {
          if (reader) {
            try {
              void reader.cancel().catch(() => {});
            } catch {
              /* Fixed disposal only. */
            }
            try {
              reader.releaseLock();
            } catch {
              /* A cancelled pending read settles separately. */
            }
          } else dispose(responseBody);
          if (activeReader === reader) activeReader = undefined;
          if (activeBody === responseBody) activeBody = undefined;
        }
      };
      const writeObservation = async (success, evidence) => {
        checked();
        if (observationWritten) throw fail();
        observationWritten = true;
        const historical = JSON.stringify({
          schemaVersion: 1,
          kind: "historical_evidence_observation",
          outcome: success ? "evidence_observed" : "held",
          category,
          statusClass: observedStatus,
          ...counts,
          observedAtMs: evidence?.observedAtMs ?? null,
          expiresAtMs: evidence?.expiresAtMs ?? null,
          tokenProfileDigest: evidence?.tokenProfileDigest ?? null,
          keySetDigest: evidence?.keySetDigest ?? null,
          observationProfileDigest: evidence?.observationProfileDigest ?? null,
        });
        await callback("onEvidenceObservation", [historical], "observation_record_denied");
      };
      const work = async () => {
        try {
          arm();
          await callback("beforeJwks", [], "before_jwks_denied");
          const jwksReply = await readJson(jwksUrl, "GET", 65536);
          category = "shape_denied";
          const at = checked();
          snapshotJson = JSON.stringify({
            schemaVersion: 1,
            profileRevision: context.profile.bindingRevision,
            environmentId: binding.environmentId,
            applicationId: binding.applicationId,
            clientId: binding.clientId,
            observedAtMs: at,
            expiresAtMs: Math.min(at + 300000, context.expiresAtMs, context.credentialExpiresAtMs),
            jwks: projectJwks(jwksReply.parsed),
          });
          const verifier = createWorkosSessionTokenVerifier(
            verificationProfile,
            snapshotJson,
            checked,
          );
          checked();
          await callback("beforePost", [], "before_post_denied");
          const postBody = JSON.stringify({
            client_id: binding.clientId,
            grant_type: "authorization_code",
            code: input.code,
            code_verifier: input.verifier,
          });
          input = undefined;
          const reply = await readJson(postUrl, "POST", 131072, postBody);
          category = "shape_denied";
          const data = reply.parsed;
          if (
            !object(data) ||
            typeof data.access_token !== "string" ||
            !data.access_token.length ||
            data.access_token.length > 16384 ||
            typeof data.refresh_token !== "string" ||
            !data.refresh_token.length ||
            data.refresh_token.length > 65536 ||
            !object(data.user) ||
            typeof data.user.id !== "string"
          )
            throw fail();
          token = data.access_token;
          const responseSubject = data.user.id;
          // The response object is not identity authority and is not retained.
          data.access_token = undefined;
          data.refresh_token = undefined;
          category = "token_denied";
          const verified = await verifier.verify(token);
          checked();
          if (verified.outcome !== "verified") throw fail();
          candidate = verifier.readCandidate(verified.handle);
          checked();
          if (
            !candidate ||
            candidate.subjectId !== responseSubject ||
            candidate.subjectId !== context.approvedSubjectId ||
            candidate.subjectId !== binding.approvedSubjectId ||
            context.priorSessionIds.includes(candidate.providerSessionId)
          )
            throw fail();
          totalEnd = Math.min(totalEnd, candidate.expiresAt * 1000);
          phaseEnd = Math.min(phaseEnd, totalEnd);
          arm();
          const target = JSON.stringify({
            schemaVersion: 1,
            operationId: context.operationId,
            activationId: context.activationId,
            sourceDigest: context.sourceDigest,
            environmentId: binding.environmentId,
            applicationId: binding.applicationId,
            clientId: binding.clientId,
            issuer,
            subjectId: candidate.subjectId,
            providerSessionId: candidate.providerSessionId,
            tokenProfileDigest: candidate.profileDigest,
            keySetDigest: candidate.keySetDigest,
            verifiedAtMs: checked(),
            tokenExpiresAtMs: candidate.expiresAt * 1000,
          });
          await callback("onVerifiedTarget", [target], "target_denied");
          if (!verifier.readCandidate(verified.handle)) {
            category = "token_denied";
            throw fail();
          }
          const compositionStart = checked();
          phaseEnd = Math.min(compositionStart + 10000, totalEnd);
          arm();
          let pageBytes = 0;
          const evidenceOwner = createWorkosAuthenticationEvidence(
            verificationProfile,
            snapshotJson,
            {
              now: checked,
              signal: abort.signal,
              currentProfile: () => {
                checked();
                return verificationProfile;
              },
              readPage: async (selectorJson, pageControl) => {
                checked();
                category = "observation_denied";
                const selector = parseWorkosSessionStatusJson(selectorJson, 8192);
                if (
                  !keys(selector, ["schemaVersion", "subjectId", "after", "limit", "order"]) ||
                  selector.schemaVersion !== 1 ||
                  selector.subjectId !== candidate.subjectId ||
                  selector.subjectId !== context.approvedSubjectId ||
                  selector.limit !== 100 ||
                  selector.order !== "asc" ||
                  !(selector.after === null || sessionId(selector.after)) ||
                  counts.sessionGetCount >= 4 ||
                  pageControl.signal.aborted ||
                  !integer(pageControl.deadlineMs)
                )
                  throw fail();
                phaseEnd = Math.min(phaseEnd, pageControl.deadlineMs);
                arm();
                const pageNumber = counts.sessionGetCount + 1;
                await callback(
                  "beforePage",
                  [selectorJson, { deadlineMs: phaseEnd, signal: abort.signal, pageNumber }],
                  "before_page_denied",
                );
                checked();
                if (pageControl.signal.aborted) {
                  category = "cancelled";
                  throw fail();
                }
                category = "credential_denied";
                let key;
                try {
                  key = context.credential();
                } catch {
                  throw fail();
                }
                if (
                  typeof key !== "string" ||
                  !key.length ||
                  Buffer.byteLength(key, "utf8") > 4096 ||
                  /[\r\n\0]/.test(key)
                )
                  throw fail();
                checked();
                if (pageControl.signal.aborted) {
                  category = "cancelled";
                  throw fail();
                }
                const url = new URL(
                  `https://api.workos.com/user_management/users/${candidate.subjectId}/sessions`,
                );
                url.searchParams.set("limit", "100");
                url.searchParams.set("order", "asc");
                if (selector.after !== null) url.searchParams.set("after", selector.after);
                let page;
                try {
                  page = await readJson(url.href, "GET", 131072, undefined, key);
                } finally {
                  key = undefined;
                }
                if ((pageBytes += page.length) > 524288) {
                  category = "body_denied";
                  throw fail();
                }
                checked();
                return page.raw;
              },
            },
          );
          category = "observation_denied";
          const composed = await evidenceOwner.verify(token);
          checked();
          if (composed.outcome !== "verified_active_evidence") throw fail();
          let evidence = evidenceOwner.readEvidence(composed.handle);
          const evidenceAt = checked();
          const owned = (fact, at) =>
            fact &&
            integer(fact.expiresAtMs) &&
            fact.expiresAtMs > at &&
            fact.providerId === "workos" &&
            fact.environmentId === binding.environmentId &&
            fact.applicationId === binding.applicationId &&
            fact.clientId === binding.clientId &&
            fact.issuer === issuer &&
            fact.tokenProvenance === "signature_verified" &&
            fact.subjectId === candidate.subjectId &&
            fact.providerSessionId === candidate.providerSessionId &&
            fact.tokenProfileDigest === candidate.profileDigest &&
            fact.keySetDigest === candidate.keySetDigest &&
            fact.sessionClientBinding === "expected_only" &&
            fact.sessionLiveness === "not_guaranteed";
          if (!owned(evidence, evidenceAt)) throw fail();
          category = "evidence_observed";
          await writeObservation(true, evidence);
          evidence = evidenceOwner.readEvidence(composed.handle);
          const finalAt = checked();
          if (!owned(evidence, finalAt)) {
            category = "observation_denied";
            throw fail();
          }
          return result("evidence_observed", counts, observedStatus, true);
        } catch {
          const heldCategory = category;
          if (!observationWritten) {
            try {
              await writeObservation(false);
            } catch {
              /* An unavailable journal never grants success. */
            }
          }
          category = heldCategory;
          return result(interruptCategory ?? heldCategory, counts, observedStatus);
        }
      };
      return Promise.race([work(), interrupted]).finally(() => {
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", externalAbort);
        abort.abort();
        if (activeReader) {
          try {
            void activeReader.cancel().catch(() => {});
          } catch {
            /* Never await disposal. */
          }
        } else dispose(activeBody);
        input = undefined;
        token = undefined;
        candidate = undefined;
        snapshotJson = undefined;
        try {
          context?.close?.();
        } catch {
          /* Releasing references confers no authority. */
        }
        callbacks = undefined;
        context = undefined;
        activeInterrupt = undefined;
      });
    },
    close() {
      closed = true;
      activeInterrupt?.("cancelled");
      try {
        context?.close?.();
      } catch {
        /* Cleanup is best effort and cannot authorize. */
      }
      context = undefined;
    },
  });
}
export function createNativeWorkosAuthenticationOperatorTransport(nativeSubpermit) {
  if (arguments.length !== 1) throw fail();
  return create(nativeSubpermit, "native", nativeFetch, Date.now);
}
export function createSyntheticWorkosAuthenticationOperatorTransport(nativeSubpermit, options) {
  if (
    !options ||
    Object.keys(options).sort().join(",") !== "clock,fetch" ||
    typeof options.fetch !== "function" ||
    typeof options.clock !== "function"
  )
    throw fail();
  return create(nativeSubpermit, "synthetic", options.fetch, options.clock);
}
