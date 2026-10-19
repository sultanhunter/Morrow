// The Turnstile challenge host (P05.T01ab, ADR-0019 item 6). `GET /auth/challenge` says
// whether the api asks for a token; if it does, the one allowlisted script loads and
// each guarded form gets one invisible widget (`execution: "execute"`, shown only if
// Turnstile needs an interaction). Every POST gets a fresh single-use token from
// `execute`, and the form resets the widget afterwards. Nothing here retries, stores
// or logs a token; a missing token is "failed", which the form shows as the existing
// "Sign-in couldn't start" copy.
import type { ChallengeAction, ChallengeHost } from "@morrow/workspace-ui";
import { isChallengeToken, type Client, type Reply } from "./client";
import { record } from "./identity-decoders";

/** The only third-party URL the SPA may load (`verify:workspace-web` allowlists it). */
export const turnstileScriptUrl =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export type ChallengeConfiguration =
  | { readonly provider: "none" }
  | {
      readonly provider: "turnstile";
      readonly siteKey: string;
      readonly actions: Readonly<Record<ChallengeAction, string>>;
    };
const siteKeyPattern = /^0x[0-9A-Za-z_-]{20,128}$/;
const actionPattern = /^[A-Za-z0-9_-]{1,32}$/;

/** `{"provider":"none"}` or the exact turnstile shape; anything else is null. */
export function decodeChallengeConfiguration(reply: Reply): ChallengeConfiguration | null {
  if (reply.kind !== "response" || reply.status !== 200 || !record(reply.body)) return null;
  const body = reply.body;
  const keys = Object.keys(body).sort().join(",");
  if (keys === "provider" && body.provider === "none") return { provider: "none" };
  if (
    keys !== "actions,provider,schemaVersion,siteKey" ||
    body.schemaVersion !== 1 ||
    body.provider !== "turnstile" ||
    typeof body.siteKey !== "string" ||
    !siteKeyPattern.test(body.siteKey) ||
    !record(body.actions) ||
    Object.keys(body.actions).sort().join(",") !== "login,signup"
  )
    return null;
  const { login, signup } = body.actions;
  if (
    typeof login !== "string" ||
    !actionPattern.test(login) ||
    typeof signup !== "string" ||
    !actionPattern.test(signup)
  )
    return null;
  return { provider: "turnstile", siteKey: body.siteKey, actions: { login, signup } };
}

interface TurnstileApi {
  render(element: HTMLElement, options: Record<string, unknown>): unknown;
  execute(widget: string): void;
  reset(widget: string): void;
  remove(widget: string): void;
}
type Prepared =
  | { readonly provider: "none" }
  | { readonly provider: "turnstile"; readonly api: TurnstileApi; readonly id: string };

export interface TurnstileHostOptions {
  readonly client: Client;
  /** The page's window; tests pass a fake. */
  readonly window?: Pick<Window, "document">;
  readonly scriptTimeoutMs?: number;
  readonly tokenTimeoutMs?: number;
}

export function createTurnstileChallengeHost(options: TurnstileHostOptions): ChallengeHost {
  const page = (options.window ?? window) as Pick<Window, "document"> & { turnstile?: unknown };
  const scriptTimeoutMs = options.scriptTimeoutMs ?? 15000;
  const tokenTimeoutMs = options.tokenTimeoutMs ?? 60000;
  let configuration: Promise<ChallengeConfiguration | null> | null = null;
  let script: Promise<TurnstileApi | null> | null = null;
  // One read per page load; a failed read is forgotten so the next attempt asks again.
  const configure = () => {
    if (configuration) return configuration;
    const pending = options.client.get("/auth/challenge").then(decodeChallengeConfiguration);
    configuration = pending;
    void pending.then((value) => {
      if (value === null && configuration === pending) configuration = null;
    });
    return pending;
  };
  const loaded = (): TurnstileApi | null => {
    const candidate = page.turnstile;
    if (candidate === null || typeof candidate !== "object") return null;
    const methods = candidate as Record<string, unknown>;
    return ["render", "execute", "reset", "remove"].every((m) => typeof methods[m] === "function")
      ? (candidate as TurnstileApi)
      : null;
  };
  const load = () => {
    if (script) return script;
    const pending = new Promise<TurnstileApi | null>((resolve) => {
      const ready = loaded();
      if (ready) return resolve(ready);
      const element = page.document.createElement("script");
      element.src = turnstileScriptUrl;
      element.async = true;
      const timer = setTimeout(() => resolve(null), scriptTimeoutMs);
      element.addEventListener("load", () => {
        clearTimeout(timer);
        resolve(loaded());
      });
      element.addEventListener("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      page.document.head.append(element);
    });
    script = pending;
    void pending.then((value) => {
      if (value === null && script === pending) script = null;
    });
    return pending;
  };
  return (action, element) => {
    let removed = false;
    let rendered: Prepared | null = null;
    let preparing: Promise<Prepared | null> | null = null;
    let waiting: ((value: string | "failed") => void) | null = null;
    const settle = (value: string | "failed") => {
      const resolve = waiting;
      waiting = null;
      resolve?.(value);
    };
    const prepare = (): Promise<Prepared | null> => {
      if (rendered) return Promise.resolve(rendered);
      preparing ??= (async (): Promise<Prepared | null> => {
        const config = await configure();
        if (!config || removed) return null;
        if (config.provider === "none") return { provider: "none" };
        const turnstile = await load();
        if (!turnstile || removed) return null;
        let id: unknown;
        try {
          id = turnstile.render(element, {
            sitekey: config.siteKey,
            action: config.actions[action],
            execution: "execute",
            appearance: "interaction-only",
            retry: "never",
            "refresh-expired": "never",
            "response-field": false,
            callback: (token: unknown) => settle(isChallengeToken(token) ? token : "failed"),
            "error-callback": () => {
              settle("failed");
              return true;
            },
            "expired-callback": () => settle("failed"),
            "timeout-callback": () => settle("failed"),
          });
        } catch {
          return null;
        }
        return typeof id === "string" && id !== ""
          ? { provider: "turnstile", api: turnstile, id }
          : null;
      })();
      const pending = preparing;
      void pending.then((value) => {
        if (preparing === pending) preparing = null;
        if (!value) return;
        // A form that unmounted while its widget rendered removes it at once.
        if (removed) {
          if (value.provider === "turnstile")
            try {
              value.api.remove(value.id);
            } catch {}
          return;
        }
        rendered = value;
      });
      return pending;
    };
    void prepare();
    return {
      async token() {
        const ready = await prepare();
        if (!ready || removed) return "failed";
        if (ready.provider === "none") return null;
        if (waiting) return "failed";
        return new Promise<string | "failed">((resolve) => {
          const timer = setTimeout(() => settle("failed"), tokenTimeoutMs);
          waiting = (value) => {
            clearTimeout(timer);
            resolve(value);
          };
          try {
            ready.api.execute(ready.id);
          } catch {
            settle("failed");
          }
        });
      },
      reset() {
        settle("failed");
        if (rendered?.provider === "turnstile")
          try {
            rendered.api.reset(rendered.id);
          } catch {}
      },
      remove() {
        removed = true;
        settle("failed");
        if (rendered?.provider === "turnstile")
          try {
            rendered.api.remove(rendered.id);
          } catch {}
        rendered = null;
      },
    };
  };
}
