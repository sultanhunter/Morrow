import { parseWorkosSessionStatusJson } from "../packages/identity/src/workos-session-status-json.ts";
import {
  consumeWorkosSessionStatusPermit,
  parseWorkosSessionStatusProfile,
} from "./workos-session-status-input.mjs";

const nativeFetch = globalThis.fetch.bind(globalThis);
const denied = () => Error("WORKOS_SESSION_STATUS_TRANSPORT_HELD");
const user = (v) => typeof v === "string" && /^user_[A-Z0-9]{26}$/.test(v);
const session = (v) => typeof v === "string" && /^session_[A-Z0-9]{26}$/.test(v);
export function workosSessionStatusEnvironmentAllowed() {
  return (
    (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "1") &&
    !Object.keys(process.env).some(
      (k) =>
        /^WORKOS_/i.test(k) ||
        /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|NODE_OPTIONS|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(
          k,
        ),
    )
  );
}
function closed(text, keys, cap = 4096) {
  const p = parseWorkosSessionStatusJson(text, cap);
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).sort().join(",") !== [...keys].sort().join(",")
  )
    throw denied();
  return Object.freeze(p);
}
function queryOf(text) {
  const p = closed(text, ["schemaVersion", "subjectId", "providerSessionId"]);
  if (p.schemaVersion !== 1 || !user(p.subjectId) || !session(p.providerSessionId)) throw denied();
  return p;
}
function cancel(body) {
  try {
    void body?.cancel().catch(() => {});
  } catch {}
}
const coarse = (status) =>
  Number.isInteger(status) && status >= 200 && status <= 599
    ? `${Math.floor(status / 100)}xx`
    : null;

function build(
  profileJson,
  queryJson,
  { fetcher, clock, current, credential, deadlineMs, close, record, observerProfileJson },
) {
  const p = parseWorkosSessionStatusProfile(profileJson),
    query = queryOf(queryJson);
  let count = 0,
    total = 0,
    failed = false,
    closedRun = false,
    firstAt = null,
    lastClock = null,
    statusClass = null,
    category = "ready",
    active = false;
  const cursors = new Set();
  const setFailure = (value) => {
    if (!failed) {
      failed = true;
      category = value;
    }
  };
  const check = (signal, endAt) => {
    if (closedRun || failed) throw denied();
    if (signal.aborted) {
      setFailure("cancelled");
      throw denied();
    }
    if (!workosSessionStatusEnvironmentAllowed()) {
      setFailure("configuration_denied");
      throw denied();
    }
    try {
      if (current() !== true) throw denied();
    } catch {
      setFailure("source_denied");
      throw denied();
    }
    let now;
    try {
      now = clock();
    } catch {
      setFailure("configuration_denied");
      throw denied();
    }
    if (!Number.isSafeInteger(now) || now < 0 || (lastClock !== null && now < lastClock)) {
      setFailure("configuration_denied");
      throw denied();
    }
    lastClock = now;
    if (!workosSessionStatusEnvironmentAllowed()) {
      setFailure("configuration_denied");
      throw denied();
    }
    if (closedRun || signal.aborted) {
      setFailure("cancelled");
      throw denied();
    }
    if (now >= endAt) {
      setFailure("timeout");
      throw denied();
    }
  };
  return Object.freeze({
    queryJson,
    observerProfileJson,
    currentProfile() {
      if (closedRun || failed) return null;
      try {
        return current() === true ? observerProfileJson : null;
      } catch {
        return null;
      }
    },
    status() {
      return Object.freeze({ category, statusClass, getCount: count });
    },
    record(outcome) {
      if (typeof record !== "function") return;
      record(outcome);
    },
    close() {
      closedRun = true;
      close?.();
    },
    async readPage(selectorJson, control) {
      if (closedRun || failed || active) {
        setFailure("already_used");
        throw denied();
      }
      active = true;
      let selector,
        signal,
        external,
        aborter,
        timer,
        reader,
        body,
        finished = false,
        interruptResolve;
      try {
        selector = closed(selectorJson, ["schemaVersion", "subjectId", "after", "limit", "order"]);
        if (
          selector.schemaVersion !== 1 ||
          selector.subjectId !== query.subjectId ||
          selector.limit !== 100 ||
          selector.order !== "asc" ||
          (selector.after !== null && !session(selector.after)) ||
          (count === 0 ? selector.after !== null : selector.after === null) ||
          (selector.after !== null && cursors.has(selector.after)) ||
          count >= 4
        ) {
          setFailure("page_denied");
          throw denied();
        }
        // control is a trusted server-code seam, not a caller data boundary.
        if (
          !control ||
          !(control.signal instanceof AbortSignal) ||
          !Number.isSafeInteger(control.deadlineMs)
        ) {
          setFailure("configuration_denied");
          throw denied();
        }
        external = control.signal;
        aborter = new AbortController();
        signal = aborter.signal;
        const now = clock();
        if (!Number.isSafeInteger(now) || now < 0) {
          setFailure("configuration_denied");
          throw denied();
        }
        if (firstAt === null) firstAt = now;
        const endAt = Math.min(firstAt + 10000, control.deadlineMs, deadlineMs ?? firstAt + 10000);
        check(signal, endAt);
        if (external.aborted) {
          setFailure("cancelled");
          throw denied();
        }
        const interrupted = new Promise((resolve) => {
          interruptResolve = resolve;
        });
        const interrupt = (value) => {
          setFailure(value);
          aborter.abort();
          interruptResolve();
        };
        const onAbort = () => interrupt("cancelled");
        external.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => interrupt("timeout"), Math.max(1, endAt - lastClock));
        const request = async () => {
          let key;
          try {
            check(signal, endAt);
            if (external.aborted) {
              setFailure("cancelled");
              throw denied();
            }
            try {
              key = credential();
            } catch {
              setFailure("credential_denied");
              throw denied();
            }
            check(signal, endAt);
            if (external.aborted) {
              setFailure("cancelled");
              throw denied();
            }
            const url = new URL(`/user_management/users/${query.subjectId}/sessions`, p.api_origin);
            url.searchParams.set("limit", "100");
            url.searchParams.set("order", "asc");
            if (selector.after !== null) url.searchParams.set("after", selector.after);
            if (selector.after !== null) cursors.add(selector.after);
            count++;
            category = "requesting";
            statusClass = null;
            const response = await fetcher(url.href, {
              method: "GET",
              redirect: "error",
              credentials: "omit",
              signal,
              headers: { accept: "application/json", authorization: "Bearer " + key },
            });
            key = null;
            if (!(response instanceof Response)) {
              setFailure("shape_denied");
              throw denied();
            }
            body = response.body;
            try {
              check(signal, endAt);
            } catch {
              cancel(response.body);
              throw denied();
            }
            if (response.url !== url.href || response.redirected) {
              setFailure("response_origin_denied");
              cancel(body);
              throw denied();
            }
            statusClass = coarse(response.status);
            if (response.status !== 200) {
              setFailure("http_rejected");
              cancel(body);
              throw denied();
            }
            const type = response.headers.get("content-type"),
              length = response.headers.get("content-length");
            if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
              setFailure("content_denied");
              cancel(body);
              throw denied();
            }
            if (
              length !== null &&
              (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > 131072)
            ) {
              setFailure("body_denied");
              cancel(body);
              throw denied();
            }
            if (!body) {
              setFailure("shape_denied");
              throw denied();
            }
            reader = body.getReader();
            let size = 0;
            const chunks = [];
            try {
              while (true) {
                const part = await reader.read();
                check(signal, endAt);
                if (part.done) break;
                if (
                  !(part.value instanceof Uint8Array) ||
                  (size += part.value.byteLength) > 131072 ||
                  total + size > 524288
                ) {
                  setFailure("body_denied");
                  void reader.cancel().catch(() => {});
                  throw denied();
                }
                chunks.push(part.value);
              }
              const bytes = new Uint8Array(size);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
              }
              let text;
              try {
                text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
                parseWorkosSessionStatusJson(text, 131072);
              } catch {
                setFailure("shape_denied");
                throw denied();
              }
              total += size;
              check(signal, endAt);
              category = "page_received";
              return text;
            } finally {
              try {
                reader.releaseLock();
              } catch {}
              reader = null;
            }
          } catch {
            key = null;
            if (!failed) setFailure("transport_failed");
            throw denied();
          }
        };
        try {
          const result = await Promise.race([request(), interrupted]);
          if (typeof result !== "string" || failed) throw denied();
          return result;
        } finally {
          finished = true;
          clearTimeout(timer);
          external.removeEventListener("abort", onAbort);
          aborter.abort();
          if (reader) {
            try {
              void reader.cancel().catch(() => {});
            } catch {}
          } else cancel(body);
        }
      } catch {
        if (!failed) setFailure("page_denied");
        throw denied();
      } finally {
        active = false;
        if (finished) clearTimeout(timer);
      }
    },
  });
}

// No native key, URL, fetch, clock or path option is accepted. Only an opaque
// permit created after protected receipt/source checks and durable claim works.
export function createNativeWorkosSessionStatusTransport(permit) {
  if (arguments.length !== 1) throw denied();
  const context = consumeWorkosSessionStatusPermit(permit);
  return build(context.profileJson, context.queryJson, {
    fetcher: nativeFetch,
    clock: Date.now,
    current: context.current,
    credential: context.credential,
    deadlineMs: context.deadlineMs,
    close: context.close,
    record: context.observe,
    observerProfileJson: context.observerProfileJson,
  });
}
export function createSyntheticWorkosSessionStatusTransport(profileJson, queryJson, options) {
  if (
    !options ||
    typeof options !== "object" ||
    Object.keys(options).some(
      (k) => !["fetch", "clock", "current", "fakeCredential", "observerProfileJson"].includes(k),
    ) ||
    typeof options.fetch !== "function" ||
    (options.clock !== undefined && typeof options.clock !== "function") ||
    (options.current !== undefined && typeof options.current !== "function") ||
    typeof options.fakeCredential !== "string" ||
    !/^synthetic-[A-Za-z0-9_-]{1,100}$/.test(options.fakeCredential)
  )
    throw denied();
  return build(profileJson, queryJson, {
    fetcher: options.fetch,
    clock: options.clock ?? Date.now,
    current: options.current ?? (() => true),
    credential: () => options.fakeCredential,
    observerProfileJson: options.observerProfileJson ?? "",
  });
}
