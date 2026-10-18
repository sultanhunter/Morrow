import { createWorkApiHandler } from "../../packages/work/src/http.js";
import type { WorkSqlConnection, WorkSqlConnector } from "../../packages/work/src/connection.js";

// lab:work-workers fixture (P06.T01a AC12, AC16, AC21, AC22). The real work
// handler runs in workerd; its SQL travels over the SQL service binding to the
// laboratory's isolated PostgreSQL 17 engine. A per-request lease models the
// broker lease: case "lease-revoke-after-send" revokes it once the command
// function has been sent. No provider, credential or network access.
interface Env {
  readonly SQL: { fetch(request: Request): Promise<Response> };
}
type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;
const origin = "https://work.morrow.test";
const held = () => Error("WORK_FIXTURE_SQL_UNAVAILABLE");

async function call(env: Env, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await env.SQL.fetch(
    new Request("https://sql.invalid/", { method: "POST", body: JSON.stringify(message) }),
  );
  const reply = (await response.json()) as Record<string, unknown>;
  if (!response.ok || reply.error) throw held();
  return reply;
}
function race<T>(pending: Promise<T>, signals: readonly AbortSignal[]): Promise<T> {
  void pending.catch(() => {});
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(held());
    for (const s of signals) {
      if (s.aborted) stop();
      s.addEventListener("abort", stop, { once: true });
    }
  });
  void stopped.catch(() => {});
  return Promise.race([pending, stopped]).finally(() => {
    for (const s of signals) if (stop) s.removeEventListener("abort", stop);
  });
}
function bridge(env: Env, labCase: string): WorkSqlConnector {
  return {
    async open(c) {
      const lease = new AbortController();
      const opened = await race(call(env, { op: "open", case: labCase }), [c.signal]);
      const id = opened.id;
      if (typeof id !== "string") throw held();
      let closed: Promise<void> | undefined;
      const connection: WorkSqlConnection = {
        async query(text, values, signal) {
          const pending = call(env, { op: "query", id, text, values: [...values] });
          if (labCase === "lease-revoke-after-send" && text.includes("FROM morrow_work.cmd_"))
            queueMicrotask(() => lease.abort());
          const reply = await race(pending, [signal, c.signal, lease.signal]);
          return { rows: reply.rows as Record<string, unknown>[] };
        },
        close() {
          closed ??= call(env, { op: "close", id }).then(
            () => {},
            () => {},
          );
          c.waitUntil(closed);
          return closed;
        },
      };
      return connection;
    },
  };
}

// Miniflare's dispatchFetch rewrites Host to its loopback address and streams
// bodies with Transfer-Encoding, so the laboratory sends a closed description and
// the exact browser-shaped Request is built here, inside workerd (as the P05
// Workers labs do). The handler then sees what the edge would deliver.
interface LabRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly bytes: number[] | null;
  readonly labCase: string;
}
export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    if (new URL(request.url).pathname !== "/__lab/request")
      return new Response(null, { status: 404 });
    const spec = (await request.json()) as LabRequest;
    let built: Request;
    try {
      built = new Request(spec.url, {
        method: spec.method,
        headers: spec.headers,
        ...(spec.bytes
          ? { body: new Uint8Array(spec.bytes) }
          : spec.body !== null
            ? { body: spec.body }
            : {}),
      });
    } catch {
      return Response.json({ unrepresentable: true }, { status: 599 });
    }
    const handler = createWorkApiHandler({
      origin,
      connector: bridge(env, spec.labCase),
      now: () => Date.now(),
    });
    return handler.fetch(built, env, ctx);
  },
};
