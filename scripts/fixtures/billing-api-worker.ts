// lab:billing-workers fixture (M5 PR-1). One module, run by the laboratory as two workerd
// Workers joined by a real service binding:
//   api     the api Worker's dispatch (apps/api/src/worker.ts createWorkspaceApiWorker) with
//           the billing API and the Stripe webhook composed as apps/api/src/deployed-worker.ts
//           composes them: the work login's connector (morrow_api_worker) and the broker's
//           Stripe methods behind the BROKER binding (createBrokerStripe, the RPC codecs).
//   broker  the ApiBroker entrypoint's four Stripe methods: the real handlers
//           (createStripeBroker) with the broker's own capabilities read from its bindings,
//           its outbound fetch, and the vault login's real transport (M2 PR-2's
//           runVaultTransactionWithDriver, morrow_vault_broker, with the D5 role preflight).
// Every SQL statement crosses the SQL service binding to the laboratory's PostgreSQL 17 as
// the one login that binding serves (each Worker gets its own). The only difference from the
// deployed pair is the driver under the two transports: a bridge instead of Neon's WebSocket.
// No provider, credential or network access: the broker's outbound goes to the fake Stripe.
import { WorkerEntrypoint } from "cloudflare:workers";
import { createBrokerStripe } from "../../apps/api/src/broker-client";
import { createWorkspaceApiWorker } from "../../apps/api/src/worker";
import { invokeBrokerMethod } from "../../apps/broker/src/capabilities";
import { createStripeBroker } from "../../apps/broker/src/stripe-broker";
import {
  runVaultTransactionWithDriver,
  type VaultDriverFactory,
} from "../../apps/broker/src/vault-database";
import type { ApiBrokerRpc, ChallengeVerdict } from "../../packages/identity/src/broker-protocol";
import type { WorkSqlConnection, WorkSqlConnector } from "../../packages/work/src/connection";

interface SqlBinding {
  fetch(request: Request): Promise<Response>;
}
interface ApiEnv {
  readonly SQL: SqlBinding;
  readonly BROKER: ApiBrokerRpc;
  readonly LAB_API_ORIGIN: string;
}
interface BrokerEnv {
  readonly SQL: SqlBinding;
}
type Context = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
const held = () => Error("BILLING_FIXTURE_SQL_UNAVAILABLE");

async function call(sql: SqlBinding, message: Record<string, unknown>) {
  const response = await sql.fetch(
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

// The api's work connector over the bridge: one bridged connection per open, as the login
// the api Worker's SQL binding serves (morrow_api_worker).
function workConnector(sql: SqlBinding): WorkSqlConnector {
  return {
    async open(c) {
      const opened = await race(call(sql, { op: "open" }), [c.signal]);
      const id = opened.id;
      if (typeof id !== "string") throw held();
      let closed: Promise<void> | undefined;
      const connection: WorkSqlConnection = {
        async query(text, values, signal) {
          const reply = await race(call(sql, { op: "query", id, text, values: [...values] }), [
            signal,
            c.signal,
          ]);
          return { rows: reply.rows as Record<string, unknown>[] };
        },
        close() {
          closed ??= call(sql, { op: "close", id }).then(
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

// The vault transport's driver over the bridge: the client shape of @neondatabase/serverless
// that runVaultTransactionWithDriver drives (connect, query with text values, end).
const bridgedDriver =
  (sql: SqlBinding): VaultDriverFactory =>
  () => {
    let id: string | null = null;
    return {
      async connect() {
        const opened = await call(sql, { op: "open" });
        if (typeof opened.id !== "string") throw held();
        id = opened.id;
      },
      async query(text: string, values: readonly string[] = []) {
        if (id === null) throw held();
        const reply = await call(sql, { op: "query", id, text, values: [...values] });
        return { rows: reply.rows };
      },
      async end() {
        if (id !== null) await call(sql, { op: "close", id }).catch(() => {});
        id = null;
      },
      on() {},
    };
  };
// The transport never opens a socket here; this stands in for the platform WebSocket.
class NoSocket {
  constructor() {
    throw held();
  }
}

// The ApiBroker entrypoint of the broker Worker: the four Stripe methods, each with the
// deployed arity checks and fixed failure (invokeBrokerMethod: one log line, BROKER_HELD).
// The others belong to lab:edge-workers and are refused here.
export class ApiBroker extends WorkerEntrypoint<BrokerEnv> implements ApiBrokerRpc {
  private stripe() {
    const sql = this.env.SQL;
    return createStripeBroker({
      transaction: (vault, budgetMs, body) =>
        runVaultTransactionWithDriver(
          bridgedDriver(sql),
          vault,
          budgetMs,
          body,
          Date.now,
          NoSocket,
        ),
      fetch: (request) => fetch(request),
      now: () => Date.now(),
    });
  }
  health(): Promise<boolean> {
    return Promise.reject(Error("BROKER_HELD"));
  }
  neonLease(): Promise<string> {
    return Promise.reject(Error("BROKER_HELD"));
  }
  workosSessionPage(): Promise<string> {
    return Promise.reject(Error("BROKER_HELD"));
  }
  challengeVerify(): Promise<ChallengeVerdict> {
    return Promise.reject(Error("BROKER_HELD"));
  }
  stripeCustomerEnsure(operationId: string, budgetMs: number): Promise<string> {
    return invokeBrokerMethod("stripeCustomerEnsure", () =>
      this.stripe().customerEnsure(this.env, operationId, budgetMs),
    );
  }
  stripeCheckoutCreate(operationId: string, budgetMs: number): Promise<string> {
    return invokeBrokerMethod("stripeCheckoutCreate", () =>
      this.stripe().checkoutCreate(this.env, operationId, budgetMs),
    );
  }
  stripePortalCreate(operationId: string, budgetMs: number): Promise<string> {
    return invokeBrokerMethod("stripePortalCreate", () =>
      this.stripe().portalCreate(this.env, operationId, budgetMs),
    );
  }
  stripeWebhookVerify(
    rawBodyBase64: string,
    signatureHeader: string,
    budgetMs: number,
  ): Promise<string> {
    return invokeBrokerMethod("stripeWebhookVerify", () =>
      this.stripe().webhookVerify(this.env, rawBodyBase64, signatureHeader, budgetMs),
    );
  }
}

// Miniflare's dispatchFetch rewrites Host and streams bodies, so the laboratory sends a
// closed description and the exact browser- or Stripe-shaped Request is built here, inside
// workerd. The response comes back described (status, Location, body).
interface LabRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}
export default {
  async fetch(request: Request, env: ApiEnv, ctx: Context): Promise<Response> {
    if (new URL(request.url).pathname !== "/__lab/request" || !env.BROKER)
      return new Response(null, { status: 404 });
    const spec = (await request.json()) as LabRequest;
    const built = new Request(spec.url, {
      method: spec.method,
      headers: spec.headers,
      redirect: "manual",
      ...(spec.body !== null ? { body: spec.body } : {}),
    });
    const connector = workConnector(env.SQL);
    const stripe = createBrokerStripe(env.BROKER);
    const now = () => Date.now();
    const api = createWorkspaceApiWorker(
      undefined,
      undefined,
      { origin: env.LAB_API_ORIGIN, connector, environment: "development", broker: stripe, now },
      { connector, environment: "development", broker: stripe, now },
    );
    const response = await api.fetch(built, env, ctx);
    return Response.json({
      status: response.status,
      location: response.headers.get("location"),
      body: await response.text(),
    });
  },
};
