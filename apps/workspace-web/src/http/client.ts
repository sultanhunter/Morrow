// The same-origin request client (P14.T01a §4.7). Requests keep the default `cors`
// mode: under the page's no-referrer policy that is what sends the exact page Origin
// (and `Sec-Fetch-Mode: cors`) that every P05/P06 guard requires; a non-cors POST
// would send `Origin: null`. Same-origin paths never trigger CORS.
export type Transport = (path: string, init: RequestInit) => Promise<Response>;

export type Reply =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly headers: Headers;
      readonly body: unknown;
      readonly json: boolean;
    }
  | { readonly kind: "not_sent"; readonly offline: boolean } // nothing left the page
  | { readonly kind: "lost" } // network error or refused redirect: the send may have happened
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }; // a read abandoned by navigation

export const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const isId = (value: unknown): value is string =>
  typeof value === "string" && idPattern.test(value);
/** Lowercase UUID v4, the only Idempotency-Key the guards accept. */
export const commandKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isCommandKey = (value: unknown): value is string =>
  typeof value === "string" && commandKeyPattern.test(value);
export function newCommandKey(): string {
  const key = crypto.randomUUID();
  if (!isCommandKey(key)) throw Error("COMMAND_KEY_INVALID");
  return key;
}
export const byteLength = (text: string) => new TextEncoder().encode(text).length;
/** P05.T01ab: the X-Morrow-Challenge shape the api guard accepts (1-2048 bytes). */
export const challengeTokenPattern = /^[A-Za-z0-9._-]{1,2048}$/;
export const isChallengeToken = (value: unknown): value is string =>
  typeof value === "string" && challengeTokenPattern.test(value);
/** M2 PR-2: the X-Morrow-CSRF value of a store-link apply (the preview's 43-char secret). */
export const csrfValuePattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const isCsrfValue = (value: unknown): value is string =>
  typeof value === "string" && csrfValuePattern.test(value);

export interface ClientOptions {
  readonly transport?: Transport;
  readonly online?: () => boolean;
  readonly readTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
}
export interface Client {
  get(path: string, signal?: AbortSignal): Promise<Reply>;
  /**
   * `challenge` adds X-Morrow-Challenge (login start and signup only); `csrf` adds
   * X-Morrow-CSRF (the store-link apply only).
   */
  post(
    path: string,
    body: string,
    idempotencyKey: string | null,
    challenge?: string | null,
    csrf?: string | null,
  ): Promise<Reply>;
}

const relativePath = (path: string) =>
  path.startsWith("/") && !path.startsWith("//") && !/[\\#\s]/.test(path);

export function createClient(options: ClientOptions = {}): Client {
  const transport: Transport = options.transport ?? ((path, init) => fetch(path, init));
  const online = options.online ?? (() => navigator.onLine !== false);
  const readTimeoutMs = options.readTimeoutMs ?? 10000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 15000;
  async function exchange(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    external?: AbortSignal,
  ): Promise<Reply> {
    if (!relativePath(path)) return { kind: "not_sent", offline: false };
    if (!online()) return { kind: "not_sent", offline: true };
    if (external?.aborted) return { kind: "aborted" };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abandon = () => controller.abort();
    external?.addEventListener("abort", abandon);
    try {
      const response = await transport(path, { ...init, signal: controller.signal });
      const text = await response.text();
      let body: unknown = undefined;
      let json = false;
      try {
        body = JSON.parse(text);
        json = true;
      } catch {}
      return { kind: "response", status: response.status, headers: response.headers, body, json };
    } catch {
      if (timedOut) return { kind: "timeout" };
      if (external?.aborted) return { kind: "aborted" };
      return { kind: "lost" };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", abandon);
    }
  }
  return {
    // Reads abort on navigation (the router's signal) or after 10 s. No body,
    // Content-Type or key; never Authorization.
    get(path, signal) {
      return exchange(
        path,
        {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { "X-Morrow-Request": "1" },
        },
        readTimeoutMs,
        signal,
      );
    },
    // Commands are never aborted by navigation; after 15 s they are uncertain.
    post(path, body, idempotencyKey, challenge = null, csrf = null) {
      const headers: Record<string, string> = {
        "X-Morrow-Request": "1",
        "Content-Type": "application/json",
      };
      if (idempotencyKey !== null) {
        if (!isCommandKey(idempotencyKey))
          return Promise.resolve({ kind: "not_sent", offline: false });
        headers["Idempotency-Key"] = idempotencyKey;
      }
      if (challenge !== null) {
        if (!isChallengeToken(challenge))
          return Promise.resolve({ kind: "not_sent", offline: false });
        headers["X-Morrow-Challenge"] = challenge;
      }
      if (csrf !== null) {
        if (!isCsrfValue(csrf)) return Promise.resolve({ kind: "not_sent", offline: false });
        headers["X-Morrow-CSRF"] = csrf;
      }
      return exchange(
        path,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers,
          body,
        },
        commandTimeoutMs,
      );
    },
  };
}
