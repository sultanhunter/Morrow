import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";
import type { AuthenticationExchangeBinding } from "./authentication-exchange-admission.js";

// Private protocol helpers. No package entrypoint or authentication handle.
const encoder = new TextEncoder();
export const loginSecret = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(v);
export const loginUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const loginId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export const loginTime = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
export const loginRevision = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export const loginFailure = () => Error("STANDALONE_LOGIN_HELD");
export class LoginInputError extends Error {
  constructor(readonly status: 400 | 403) {
    super("STANDALONE_LOGIN_INPUT_INVALID");
  }
}
export function loginJson(value: unknown, limit: number, keys: readonly string[]) {
  if (typeof value !== "string" || encoder.encode(value).length > limit) throw loginFailure();
  const parsed = parseWorkosSessionStatusJson(value, limit);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== [...keys].sort().join(",")
  )
    throw loginFailure();
  return Object.freeze(parsed as Record<string, unknown>);
}
export function loginBase64(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function loginBytes(text: string, maximum: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > Math.ceil((maximum * 4) / 3))
    throw loginFailure();
  const bytes = Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4)),
    (c) => c.charCodeAt(0),
  );
  if (bytes.length > maximum || loginBase64(bytes) !== text) throw loginFailure();
  return bytes;
}
export async function loginHash(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export interface LoginConfiguration {
  readonly origin: string;
  readonly retentionTier: "development" | "staging" | "production";
  readonly authenticationBindingJson: string;
  readonly verificationProfileJson: string;
  readonly profileId: string;
  readonly profileRecordRevision: number;
  readonly binding: Readonly<AuthenticationExchangeBinding>;
  readonly configurationDigest: string;
}
export async function parseLoginConfiguration(
  value: unknown,
): Promise<Readonly<LoginConfiguration>> {
  return parseLoginConfigurationCore(value);
}
export async function parseLoginConfigurationWithAttempt(
  value: unknown,
  originalAttempt: LoginAttempt,
): Promise<Readonly<LoginConfiguration>> {
  return parseLoginConfigurationCore(value, originalAttempt);
}
async function parseLoginConfigurationCore(
  value: unknown,
  attempt?: LoginAttempt,
): Promise<Readonly<LoginConfiguration>> {
  try {
    const c = loginJson(value, 32768, [
      "schemaVersion",
      "controllerProtocol",
      "origin",
      "retentionTier",
      "authenticationBindingJson",
      "verificationProfileJson",
      "profileId",
      "profileRecordRevision",
    ]);
    if (
      c.schemaVersion !== 1 ||
      c.controllerProtocol !== "morrow-login-v1" ||
      typeof c.origin !== "string" ||
      encoder.encode(c.origin).length > 512 ||
      !["development", "staging", "production"].includes(c.retentionTier as string) ||
      !loginId(c.profileId) ||
      !loginRevision(c.profileRecordRevision)
    )
      throw loginFailure();
    const url = new URL(c.origin);
    if (url.origin !== c.origin || url.protocol !== "https:" || url.username || url.password)
      throw loginFailure();
    const b = loginJson(c.authenticationBindingJson, 8192, [
      "bindingId",
      "bindingRevision",
      "environmentId",
      "applicationId",
      "clientId",
      "redirectUri",
      "returnPath",
    ]);
    const p = loginJson(c.verificationProfileJson, 8192, [
      "schemaVersion",
      "providerId",
      "environmentId",
      "applicationId",
      "clientId",
      "issuer",
      "revision",
      "audiencePolicy",
    ]);
    if (
      !loginId(b.bindingId) ||
      !loginRevision(b.bindingRevision) ||
      typeof b.environmentId !== "string" ||
      !/^environment_[A-Z0-9]{26}$/.test(b.environmentId) ||
      typeof b.applicationId !== "string" ||
      !/^app_[A-Z0-9]{26}$/.test(b.applicationId) ||
      typeof b.clientId !== "string" ||
      !/^client_[A-Z0-9]{26}$/.test(b.clientId) ||
      b.redirectUri !== c.origin + "/auth/workos/callback" ||
      b.returnPath !== "/" ||
      p.schemaVersion !== 1 ||
      p.providerId !== "workos" ||
      p.audiencePolicy !== "absent" ||
      p.environmentId !== b.environmentId ||
      p.applicationId !== b.applicationId ||
      p.clientId !== b.clientId ||
      p.issuer !== `https://api.workos.com/user_management/${b.clientId}` ||
      !loginRevision(p.revision)
    )
      throw loginFailure();
    const binding = b as unknown as Readonly<AuthenticationExchangeBinding>;
    // Preserve the raw profile bytes and ordered outer transcript. Controlled
    // setup checks before each actual digest, never only around the whole parser.
    attempt?.check();
    const profilePending = loginHash(c.verificationProfileJson as string);
    if (attempt) void profilePending.catch(() => {});
    const profileDigest = await (attempt ? attempt.wait(profilePending) : profilePending);
    attempt?.check();
    const configurationPending = loginHash(
      JSON.stringify([
        "morrow.login.configuration",
        "1",
        c.controllerProtocol,
        c.origin,
        c.retentionTier,
        binding.bindingId,
        String(binding.bindingRevision),
        binding.environmentId,
        binding.applicationId,
        binding.clientId,
        binding.redirectUri,
        binding.returnPath,
        c.profileId,
        String(c.profileRecordRevision),
        profileDigest,
      ]),
    );
    if (attempt) void configurationPending.catch(() => {});
    const configurationDigest = await (attempt
      ? attempt.wait(configurationPending)
      : configurationPending);
    attempt?.check();
    return Object.freeze({
      origin: c.origin,
      retentionTier: c.retentionTier as LoginConfiguration["retentionTier"],
      authenticationBindingJson: c.authenticationBindingJson as string,
      verificationProfileJson: c.verificationProfileJson as string,
      profileId: c.profileId,
      profileRecordRevision: c.profileRecordRevision,
      binding,
      configurationDigest,
    });
  } catch {
    throw Error("STANDALONE_LOGIN_CONFIGURATION_INVALID");
  }
}
export interface LoginControl {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
export function createLoginAttempt(now: () => number, signal: AbortSignal, duration: number) {
  let previous = -1,
    deadline = 0,
    ended = false;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => abort.abort();
  const clock = () => {
    const at: unknown = now();
    if (!loginTime(at) || at < previous) {
      abort.abort();
      throw loginFailure();
    }
    previous = at;
    return at;
  };
  const start = clock();
  deadline = start + duration;
  if (!loginTime(deadline)) throw loginFailure();
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(cancel, Math.max(0, deadline - clock()));
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    schedule();
  } catch {
    signal.removeEventListener("abort", cancel);
    if (timer !== undefined) clearTimeout(timer);
    abort.abort();
    throw loginFailure();
  }
  const check = () => {
    const at = clock();
    if (ended || abort.signal.aborted || signal.aborted || at >= deadline) {
      abort.abort();
      throw loginFailure();
    }
    return at;
  };
  return Object.freeze({
    check,
    control: (): Readonly<LoginControl> =>
      Object.freeze({ deadlineMs: deadline, signal: abort.signal }),
    cap(at: number) {
      check();
      if (!loginTime(at)) throw loginFailure();
      deadline = Math.min(deadline, at);
      schedule();
      check();
    },
    async wait<T>(pending: Promise<T>): Promise<T> {
      // Authority can end before the first check. Consume only late rejection
      // of work already started; the original Promise and all checks remain.
      void pending.catch(() => {});
      check();
      let stop: (() => void) | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        stop = () => reject(loginFailure());
        abort.signal.addEventListener("abort", stop, { once: true });
      });
      try {
        const value = await Promise.race([pending, interrupted]);
        check();
        return value;
      } finally {
        if (stop) abort.signal.removeEventListener("abort", stop);
      }
    },
    end() {
      ended = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      abort.abort();
    },
  });
}
export type LoginAttempt = ReturnType<typeof createLoginAttempt>;
export function loginCookie(request: Request): string {
  const raw = request.headers.get("cookie");
  if (!raw || raw.length > 4096 || /[^\x20-\x7e]/.test(raw)) throw loginFailure();
  const pairs = raw.split(";");
  if (pairs.length > 32) throw loginFailure();
  let secret: string | undefined;
  const seen = new Set<string>();
  for (const pair of pairs) {
    const m = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/.exec(
      pair.trim(),
    );
    if (!m) throw loginFailure();
    const key = m[1]!,
      lower = key.toLowerCase();
    if (lower === "__host-morrow_login" || lower === "__host-morrow_session") {
      if (seen.has(lower) || (key !== "__Host-morrow_login" && key !== "__Host-morrow_session"))
        throw loginFailure();
      seen.add(lower);
      if (!loginSecret(m[2])) throw loginFailure();
      if (key === "__Host-morrow_login") secret = m[2];
    }
  }
  if (!secret) throw loginFailure();
  return secret;
}
export function loginRequestEnvelope(request: Request, origin: string): URL {
  const url = new URL(request.url);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    request.url.length > 8192 ||
    (request.headers.has("host") && request.headers.get("host") !== new URL(origin).host)
  )
    throw new LoginInputError(400);
  if (request.headers.has("authorization")) throw new LoginInputError(403);
  let bytes = 0,
    count = 0;
  for (const [key, value] of request.headers) {
    bytes += encoder.encode(key).length + encoder.encode(value).length + 4;
    count++;
  }
  if (bytes > 8192 || count > 64) throw new LoginInputError(400);
  if (
    request.method === "GET" &&
    (request.headers.has("transfer-encoding") ||
      (request.headers.has("content-length") && request.headers.get("content-length") !== "0"))
  )
    throw new LoginInputError(400);
  return url;
}
export function loginCallbackInput(
  request: Request,
  url: URL,
): Readonly<{ code: string; state: string; cookie: string }> {
  if (request.method !== "GET" || url.pathname !== "/auth/workos/callback") throw loginFailure();
  const fields = url.search.slice(1).split("&");
  if (fields.length !== 2) throw loginFailure();
  const values = new Map<string, string>();
  for (const field of fields) {
    const split = field.indexOf("=");
    if (split < 1) throw loginFailure();
    const key = field.slice(0, split);
    if ((key !== "code" && key !== "state") || values.has(key)) throw loginFailure();
    const value = decodeURIComponent(field.slice(split + 1).replaceAll("+", " "));
    values.set(key, value);
  }
  const code = values.get("code"),
    state = values.get("state");
  if (
    typeof code !== "string" ||
    !code.length ||
    code.length > 4096 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(code) ||
    !loginSecret(state)
  )
    throw loginFailure();
  if (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
    throw loginFailure();
  const site = request.headers.get("sec-fetch-site"),
    mode = request.headers.get("sec-fetch-mode"),
    dest = request.headers.get("sec-fetch-dest");
  if (
    (site !== null && !["same-origin", "same-site", "cross-site", "none"].includes(site)) ||
    (mode !== null && mode !== "navigate") ||
    (dest !== null && dest !== "document")
  )
    throw loginFailure();
  return Object.freeze({ code, state, cookie: loginCookie(request) });
}
export async function loginStartInput(request: Request, attempt: LoginAttempt): Promise<string> {
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("content-type") !== "application/json" ||
    request.headers.get("x-morrow-request") !== "1"
  )
    throw new LoginInputError(403);
  const site = request.headers.get("sec-fetch-site"),
    mode = request.headers.get("sec-fetch-mode"),
    dest = request.headers.get("sec-fetch-dest");
  if (
    (site !== null && site !== "same-origin") ||
    (mode !== null && mode !== "cors" && mode !== "same-origin") ||
    (dest !== null && dest !== "empty")
  )
    throw new LoginInputError(403);
  const reader = request.body?.getReader();
  if (!reader) throw new LoginInputError(400);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await attempt.wait(reader.read());
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 512) throw new LoginInputError(400);
      chunks.push(next.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    let input: Readonly<Record<string, unknown>>;
    try {
      input = loginJson(new TextDecoder("utf-8", { fatal: true }).decode(body), 512, [
        "schemaVersion",
        "workspaceId",
      ]);
    } catch {
      throw new LoginInputError(400);
    }
    if (input.schemaVersion !== 1 || !loginId(input.workspaceId)) throw new LoginInputError(400);
    return input.workspaceId;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
