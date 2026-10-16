import type { FixedWorkosLoginPort } from "./standalone-login.js";
import {
  loginBytes,
  loginJson,
  loginSecret,
  loginTime,
  loginUuid,
  parseLoginConfiguration,
  type LoginControl,
} from "./standalone-login-protocol.js";
import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";

// These constructors are private composition dependencies, not package entrypoints.
export interface SessionCredentialBroker {
  borrow(selectorJson: string, control: Readonly<LoginControl>): Promise<unknown>;
}
interface Dependencies {
  readonly configurationJson: string;
  readonly sessionCredentialBroker: Readonly<SessionCredentialBroker>;
  readonly now: () => number;
}
interface Lease {
  readonly namespaceJson: string;
  readonly credential: string;
  readonly expiresAtMs: number;
  readonly revocationSignal: AbortSignal;
  readonly release: (control: Readonly<LoginControl>) => Promise<void>;
}
const held = () => Error("WORKOS_LOGIN_PORT_HELD");
const encoder = new TextEncoder();
const endpoint = "https://api.workos.com";
const ownData = (value: unknown, names: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw held();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== names.length ||
    names.some((name) => !descriptors[name] || !("value" in descriptors[name]!))
  )
    throw held();
  return Object.fromEntries(names.map((name) => [name, descriptors[name]!.value]));
};
function nativeEnvironment(): void {
  const process = (
    globalThis as unknown as {
      process?: { versions?: { node?: string }; env?: Record<string, string | undefined> };
    }
  ).process;
  if (!process?.versions?.node) return;
  const env = process.env;
  if (
    !env ||
    (env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") ||
    Object.keys(env).some(
      (key) =>
        /^WORKOS_/i.test(key) ||
        /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|NODE_OPTIONS|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(
          key,
        ),
    )
  )
    throw held();
}
function operation(
  now: () => number,
  input: Readonly<LoginControl>,
  maximum: number,
  guard: () => void,
) {
  const c = ownData(input, ["deadlineMs", "signal"]);
  if (!loginTime(c.deadlineMs) || !(c.signal instanceof AbortSignal)) throw held();
  const parent = c.signal;
  const abort = new AbortController();
  let previous = -1,
    ended = false,
    deadline = c.deadlineMs,
    timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStop: (reason: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => (rejectStop = reject));
  void stopped.catch(() => {});
  const stop = () => {
    abort.abort();
    rejectStop(held());
  };
  const clock = () => {
    const at: unknown = now();
    if (!loginTime(at) || at < previous) {
      stop();
      throw held();
    }
    previous = at;
    return at;
  };
  const check = () => {
    guard();
    const at = clock();
    if (ended || parent.aborted || abort.signal.aborted || at >= deadline) {
      stop();
      throw held();
    }
    return at;
  };
  const start = check();
  if (!loginTime(start + maximum)) throw held();
  deadline = Math.min(deadline, start + maximum);
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(stop, Math.max(0, deadline - check()));
  };
  parent.addEventListener("abort", stop, { once: true });
  const additional: AbortSignal[] = [];
  try {
    arm();
  } catch {
    parent.removeEventListener("abort", stop);
    stop();
    throw held();
  }
  return {
    check,
    control: (): Readonly<LoginControl> =>
      Object.freeze({ deadlineMs: deadline, signal: abort.signal }),
    cap(expiresAtMs: number, signal: AbortSignal) {
      check();
      if (!loginTime(expiresAtMs) || signal.aborted) throw held();
      deadline = Math.min(deadline, expiresAtMs);
      signal.addEventListener("abort", stop, { once: true });
      additional.push(signal);
      arm();
      check();
    },
    async wait<T>(pending: Promise<T>, late?: (value: T) => void): Promise<T> {
      // Register custody before checking: even a resource that is already late
      // must have its one disposal attempt rather than disappear behind a race.
      const observed = Promise.resolve(pending).then((value) => {
        try {
          check();
          return value;
        } catch {
          late?.(value);
          throw held();
        }
      });
      void observed.catch(() => {});
      check();
      try {
        const value = await Promise.race([observed, stopped]);
        try {
          check();
        } catch {
          late?.(value);
          throw held();
        }
        return value;
      } catch {
        stop();
        throw held();
      }
    },
    end() {
      ended = true;
      if (timer !== undefined) clearTimeout(timer);
      parent.removeEventListener("abort", stop);
      for (const signal of additional) signal.removeEventListener("abort", stop);
      stop();
    },
  };
}
type Operation = ReturnType<typeof operation>;

// Cleanup is deliberately independent of operation authority. It never returns
// data, restores a held operation or retries an already invoked disposer.
async function cleanup(now: () => number, action: (control: Readonly<LoginControl>) => unknown) {
  const abort = new AbortController();
  let at: unknown;
  try {
    at = now();
  } catch {
    at = undefined;
  }
  const deadlineMs = loginTime(at) && loginTime(at + 1000) ? at + 1000 : 0;
  if (!deadlineMs) abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        abort.abort();
        reject(held());
      },
      deadlineMs ? 1000 : 0,
    );
  });
  void expired.catch(() => {});
  try {
    const result = Promise.resolve(action(Object.freeze({ deadlineMs, signal: abort.signal })));
    void result.catch(() => {});
    await Promise.race([result, expired]);
    const endedAt: unknown = now();
    if (
      !loginTime(endedAt) ||
      !loginTime(at) ||
      endedAt < at ||
      endedAt >= deadlineMs ||
      abort.signal.aborted
    )
      throw held();
  } catch {
    // Attempted cleanup is not acknowledged cleanup. No success is derived here.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abort.abort();
  }
}
function custody(now: () => number) {
  const leases = new WeakSet<object>();
  const bodies = new WeakSet<object>();
  const readers = new WeakSet<object>();
  return {
    lease(value: unknown, original?: Operation): Promise<void> {
      if (!value || typeof value !== "object" || leases.has(value)) return Promise.resolve();
      const release = Object.getOwnPropertyDescriptor(value, "release")?.value;
      if (typeof release !== "function") return Promise.resolve();
      if (original) {
        original.check();
        leases.add(value);
        // A normal release must acknowledge inside the original lifetime.
        const pending = release.call(value, original.control());
        if (!(pending instanceof Promise)) throw held();
        return original.wait(pending).then(() => {
          original.check();
        });
      }
      leases.add(value);
      return cleanup(now, (control) => release.call(value, control));
    },
    response(value: unknown) {
      if (!(value instanceof Response) || !value.body || bodies.has(value.body)) return;
      bodies.add(value.body);
      void cleanup(now, () => value.body!.cancel());
    },
    reader(value: ReadableStreamDefaultReader<Uint8Array>) {
      if (readers.has(value)) return;
      readers.add(value);
      void cleanup(now, () => value.cancel());
    },
  };
}
type Custody = ReturnType<typeof custody>;
async function readJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  attempt: Operation,
  resources: Custody,
): Promise<{ text: string; parsed: unknown }> {
  let response: Response | undefined,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    consumed = false;
  try {
    attempt.check();
    response = await attempt.wait(
      fetcher(url, { ...init, signal: attempt.control().signal }),
      resources.response,
    );
    attempt.check();
    if (
      !(response instanceof Response) ||
      response.url !== url ||
      response.redirected ||
      response.status !== 200
    )
      throw held();
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      throw held();
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > 131072))
      throw held();
    if (!response.body) throw held();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      attempt.check();
      const part = await attempt.wait(reader.read());
      attempt.check();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw held();
      const chunk = Uint8Array.prototype.slice.call(part.value) as Uint8Array;
      if ((total += chunk.byteLength) > 131072) throw held();
      chunks.push(chunk);
    }
    consumed = true;
    reader.releaseLock();
    reader = undefined;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = parseWorkosSessionStatusJson(text, 131072);
    attempt.check();
    return { text, parsed };
  } finally {
    if (!consumed) {
      if (reader) resources.reader(reader);
      else if (response) resources.response(response);
    }
  }
}
function keyset(value: unknown): unknown {
  const top = ownData(value, ["keys"]);
  if (!Array.isArray(top.keys) || top.keys.length < 1 || top.keys.length > 16) throw held();
  const fields = ["kty", "kid", "n", "e", "alg", "use", "key_ops"];
  return {
    keys: top.keys.map((key: unknown) => {
      if (
        !key ||
        typeof key !== "object" ||
        Array.isArray(key) ||
        Object.keys(key).some((name) => ![...fields, "x5c", "x5t#S256"].includes(name))
      )
        throw held();
      const data = key as Record<string, unknown>;
      if (Object.hasOwn(data, "x5c")) {
        if (!Array.isArray(data.x5c) || data.x5c.length < 1 || data.x5c.length > 4) throw held();
        let total = 0;
        for (const certificate of data.x5c) {
          if (
            typeof certificate !== "string" ||
            !certificate.length ||
            certificate.length > 10924 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(certificate)
          )
            throw held();
          const raw = atob(certificate);
          if (
            !raw.length ||
            raw.length > 8192 ||
            btoa(raw) !== certificate ||
            (total += raw.length) > 16384
          )
            throw held();
        }
      }
      if (
        Object.hasOwn(data, "x5t#S256") &&
        (!loginSecret(data["x5t#S256"]) || loginBytes(data["x5t#S256"] as string, 32).length !== 32)
      )
        throw held();
      return Object.fromEntries(
        fields.filter((name) => Object.hasOwn(data, name)).map((name) => [name, data[name]]),
      );
    }),
  };
}
async function create(
  dependencies: Dependencies,
  fetcher: typeof fetch,
  guard: () => void,
  redirect: "error" | "manual",
): Promise<Readonly<FixedWorkosLoginPort>> {
  try {
    guard();
    if (
      typeof fetcher !== "function" ||
      typeof dependencies.now !== "function" ||
      typeof dependencies.sessionCredentialBroker?.borrow !== "function"
    )
      throw held();
    const configuration = await parseLoginConfiguration(dependencies.configurationJson);
    const profile = loginJson(configuration.verificationProfileJson, 8192, [
      "schemaVersion",
      "providerId",
      "environmentId",
      "applicationId",
      "clientId",
      "issuer",
      "revision",
      "audiencePolicy",
    ]);
    const { binding } = configuration;
    const now = dependencies.now;
    const borrow = dependencies.sessionCredentialBroker.borrow.bind(
      dependencies.sessionCredentialBroker,
    );
    const namespaceJson = JSON.stringify({
      schemaVersion: 1,
      providerId: "workos",
      environmentId: binding.environmentId,
      applicationId: binding.applicationId,
      clientId: binding.clientId,
      purpose: "list_active_sessions",
    });
    guard();
    const run = async (
      control: Readonly<LoginControl>,
      maximum: number,
      execute: (attempt: Operation, resources: Custody) => Promise<string>,
    ) => {
      let attempt: Operation | undefined;
      try {
        attempt = operation(now, control, maximum, guard);
        const result = await execute(attempt, custody(now));
        attempt.check();
        return result;
      } catch {
        throw held();
      } finally {
        attempt?.end();
      }
    };
    const request = (method: "POST" | "GET", body?: string, credential?: string): RequestInit => ({
      method,
      headers: {
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...(credential === undefined ? {} : { authorization: "Bearer " + credential }),
      },
      ...(body === undefined ? {} : { body }),
      redirect,
      credentials: "omit",
      cache: "no-store",
      referrer: "",
      referrerPolicy: "no-referrer",
    });
    return Object.freeze({
      exchange: (inputJson: string, control: Readonly<LoginControl>) =>
        run(control, 10000, async (attempt, resources) => {
          const input = loginJson(inputJson, 32768, [
            "schemaVersion",
            "admissionId",
            "code",
            "verifier",
            "clientId",
            "redirectUri",
          ]);
          if (
            input.schemaVersion !== 1 ||
            !loginUuid(input.admissionId) ||
            typeof input.code !== "string" ||
            !input.code.length ||
            input.code.length > 4096 ||
            !loginSecret(input.verifier) ||
            input.clientId !== binding.clientId ||
            input.redirectUri !== binding.redirectUri
          )
            throw held();
          const body = JSON.stringify({
            client_id: binding.clientId,
            grant_type: "authorization_code",
            code: input.code,
            code_verifier: input.verifier,
          });
          const reply = await readJson(
            fetcher,
            endpoint + "/user_management/authenticate",
            request("POST", body),
            attempt,
            resources,
          );
          if (!reply.parsed || typeof reply.parsed !== "object" || Array.isArray(reply.parsed))
            throw held();
          const token = (reply.parsed as Record<string, unknown>).access_token;
          if (
            typeof token !== "string" ||
            encoder.encode(token).length > 16384 ||
            !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
          )
            throw held();
          const output = JSON.stringify({ schemaVersion: 1, accessToken: token });
          if (encoder.encode(output).length > 32768) throw held();
          attempt.check();
          return output;
        }),
      readPublicKeyset: (control: Readonly<LoginControl>) =>
        run(control, 5000, async (attempt, resources) => {
          const url = new URL("/sso/jwks/" + binding.clientId, endpoint).href;
          const reply = await readJson(fetcher, url, request("GET"), attempt, resources);
          const jwks = keyset(reply.parsed);
          const observedAtMs = attempt.check();
          if (!loginTime(observedAtMs + 300000)) throw held();
          const output = JSON.stringify({
            schemaVersion: 1,
            profileRevision: profile.revision,
            environmentId: binding.environmentId,
            applicationId: binding.applicationId,
            clientId: binding.clientId,
            observedAtMs,
            expiresAtMs: observedAtMs + 300000,
            jwks,
          });
          if (encoder.encode(output).length > 65536) throw held();
          attempt.check();
          return output;
        }),
      readSessionPage: (selectorJson: string, control: Readonly<LoginControl>) =>
        run(control, 10000, async (attempt, resources) => {
          const selector = loginJson(selectorJson, 2048, [
            "schemaVersion",
            "subjectId",
            "after",
            "limit",
            "order",
          ]);
          if (
            selector.schemaVersion !== 1 ||
            typeof selector.subjectId !== "string" ||
            !/^user_[A-Z0-9]{26}$/.test(selector.subjectId) ||
            (selector.after !== null &&
              (typeof selector.after !== "string" ||
                !/^session_[A-Z0-9]{26}$/.test(selector.after))) ||
            selector.limit !== 100 ||
            selector.order !== "asc"
          )
            throw held();
          const url = new URL(
            "/user_management/users/" + selector.subjectId + "/sessions",
            endpoint,
          );
          url.searchParams.set("limit", "100");
          url.searchParams.set("order", "asc");
          if (selector.after !== null) url.searchParams.set("after", selector.after as string);
          let raw: unknown;
          try {
            attempt.check();
            raw = await attempt.wait(borrow(namespaceJson, attempt.control()), (value) => {
              void resources.lease(value);
            });
            attempt.check();
            const lease = ownData(raw, [
              "namespaceJson",
              "credential",
              "expiresAtMs",
              "revocationSignal",
              "release",
            ]) as unknown as Lease;
            if (
              lease.namespaceJson !== namespaceJson ||
              typeof lease.credential !== "string" ||
              !/^[\x21-\x7e]{16,4096}$/.test(lease.credential) ||
              !loginTime(lease.expiresAtMs) ||
              lease.expiresAtMs <= attempt.check() ||
              !(lease.revocationSignal instanceof AbortSignal) ||
              typeof lease.release !== "function"
            )
              throw held();
            attempt.cap(lease.expiresAtMs, lease.revocationSignal);
            const reply = await readJson(
              fetcher,
              url.href,
              request("GET", undefined, lease.credential),
              attempt,
              resources,
            );
            await resources.lease(raw, attempt);
            attempt.check();
            return reply.text;
          } finally {
            if (raw !== undefined) void resources.lease(raw);
          }
        }),
    });
  } catch {
    throw held();
  }
}
export async function createFixedWorkosLoginPort(
  dependencies: Dependencies,
): Promise<Readonly<FixedWorkosLoginPort>> {
  try {
    ownData(dependencies, ["configurationJson", "sessionCredentialBroker", "now"]);
    nativeEnvironment();
    const fetcher = globalThis.fetch.bind(globalThis);
    return await create(dependencies, fetcher, nativeEnvironment, "error");
  } catch {
    throw held();
  }
}
export async function createSyntheticFixedWorkosLoginPort(
  dependencies: Dependencies & { readonly fetch: typeof fetch },
): Promise<Readonly<FixedWorkosLoginPort>> {
  try {
    ownData(dependencies, ["configurationJson", "sessionCredentialBroker", "now", "fetch"]);
    return await create(dependencies, dependencies.fetch, () => {}, "error");
  } catch {
    throw held();
  }
}
export async function createWorkersFixedWorkosLoginPort(
  dependencies: Dependencies,
): Promise<Readonly<FixedWorkosLoginPort>> {
  try {
    ownData(dependencies, ["configurationJson", "sessionCredentialBroker", "now"]);
    const fetcher = globalThis.fetch.bind(globalThis);
    return await create(dependencies, fetcher, () => {}, "manual");
  } catch {
    throw held();
  }
}
