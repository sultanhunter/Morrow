// lab:shopify-connect-workers fixture (M2 PR-2). Inside workerd it runs the real code of
// the three hosts of the Shopify install and link:
//   connector  createConnectorHandler (launch, callback, status, webhooks) with its own
//              login's transport (createConnectorDatabase, morrow_connector_ingress);
//   broker     createShopifyBroker (the ConnectorBroker methods' handlers) on the vault
//              login's transport (runVaultTransactionWithDriver, morrow_vault_broker), with
//              the broker's own capabilities (the vault keyring from its bindings) and its
//              outbound fetch to the synthetic Shopify;
//   api        the store-link guard with the P09.T02a issuer in preview, apply and status,
//              and GET /workspace/:ws/connections, on the linking login, with the policy
//              package's connection kernel (as apps/api/src/deployed-worker.ts wires it).
// Every SQL statement crosses the SQL service binding to the laboratory's PostgreSQL 17 as
// the login each transport names; the D5 role preflight runs against the real roles. The
// RPC hop between connector and broker is a direct call here (the ConnectorBroker binding
// itself is proved by lab:edge-workers). No provider, credential or network access.
import { createConnectorHandler } from "../../apps/shopify-connector/worker/connector";
import {
  createConnectorDatabase,
  type ConnectorDriverFactory,
} from "../../apps/shopify-connector/worker/database";
import { createShopifyBroker } from "../../apps/broker/src/shopify-install";
import {
  runVaultTransactionWithDriver,
  type VaultDriverFactory,
} from "../../apps/broker/src/vault-database";
import { parseBrokerDatabaseBinding } from "../../packages/identity/src/broker-protocol";
import { createStandaloneRequestGuard } from "../../packages/identity/src/standalone-request-guard";
import { createStandaloneStoreLinkingExecution } from "../../packages/identity/src/standalone-store-linking";
import { executeWorkspaceConnections } from "../../packages/identity/src/shopify-link-issuer";
import type { StandaloneWorkspaceSqlPool } from "../../packages/identity/src/standalone-workspace-bootstrap";
import { createConnectionKernel } from "../../packages/policy/src/connection-authority";

interface Env {
  readonly SQL: { fetch(request: Request): Promise<Response> };
  readonly MORROW_ENVIRONMENT: string;
  readonly MORROW_DATABASE_BINDING_JSON: string;
  readonly LAB_CONNECTOR_ORIGIN: string;
  readonly LAB_API_ORIGIN: string;
  readonly LAB_LEASE_PASSWORD: string;
}
const held = () => Error("SHOPIFY_CONNECT_FIXTURE_SQL_UNAVAILABLE");
async function call(env: Env, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await env.SQL.fetch(
    new Request("https://sql.invalid/", { method: "POST", body: JSON.stringify(message) }),
  );
  const reply = (await response.json()) as Record<string, unknown>;
  if (!response.ok || reply.error) throw held();
  return reply;
}
// One bridged connection as a named login: the driver shape both transports use.
function bridgedClient(env: Env, user: string) {
  let id: string | null = null;
  return {
    async connect() {
      const opened = await call(env, { op: "open", user });
      if (typeof opened.id !== "string") throw held();
      id = opened.id;
    },
    async query(text: string, values: readonly string[] = []) {
      if (id === null) throw held();
      const reply = await call(env, { op: "query", id, text, values: [...values] });
      return { rows: reply.rows };
    },
    async end() {
      if (id !== null) await call(env, { op: "close", id }).catch(() => {});
      id = null;
    },
    on() {},
  };
}
// The transports never open a socket here; this stands in for the platform WebSocket.
class NoSocket {
  constructor() {
    throw held();
  }
}
const linkingPool = (env: Env): StandaloneWorkspaceSqlPool => ({
  async connect() {
    const client = bridgedClient(env, "morrow_identity_linking");
    await client.connect();
    return {
      async query(text, values) {
        return (await client.query(text, values)) as { rows: Record<string, unknown>[] };
      },
      async release() {
        await client.end();
      },
    };
  },
});

interface LabRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}
const apiRoute =
  /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/(connections|store-links|store-links\/preview|store-links\/status)$/;

// The response is described back to the laboratory (status, Location, Set-Cookie, body), so
// a redirect to Shopify or the api is never followed outside workerd.
async function describe(response: Response): Promise<Response> {
  return Response.json({
    status: response.status,
    location: response.headers.get("location"),
    contentType: response.headers.get("content-type"),
    cookies: response.headers.getSetCookie(),
    body: await response.text(),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/__lab/request")
      return new Response(null, { status: 404 });
    return describe(await handle(request, env));
  },
};

async function handle(request: Request, env: Env): Promise<Response> {
  {
    // Miniflare's dispatchFetch rewrites Host; the exact browser- or Shopify-shaped request
    // is built here, inside workerd.
    const spec = (await request.json()) as LabRequest;
    const built = new Request(spec.url, {
      method: spec.method,
      headers: spec.headers,
      redirect: "manual",
      ...(spec.body !== null ? { body: spec.body } : {}),
    });
    const url = new URL(spec.url);
    const binding = parseBrokerDatabaseBinding(env.MORROW_DATABASE_BINDING_JSON);
    if (url.origin === env.LAB_CONNECTOR_ORIGIN) {
      const vaultDriver: VaultDriverFactory = (config) => bridgedClient(env, config.user);
      const shopify = createShopifyBroker({
        transaction: (vault, budgetMs, body) =>
          runVaultTransactionWithDriver(
            vaultDriver,
            vault,
            Math.min(10000, budgetMs * 3),
            body,
            Date.now,
            NoSocket,
          ),
        fetch: (target, init) => fetch(target, init),
        now: () => Date.now(),
      });
      const connectorDriver: ConnectorDriverFactory = (config) => bridgedClient(env, config.user);
      const handler = createConnectorHandler({
        configuration: { origin: env.LAB_CONNECTOR_ORIGIN, apiOrigin: env.LAB_API_ORIGIN },
        broker: {
          shopifyLaunchVerify: (appKey, rawQuery) => shopify.launchVerify(env, appKey, rawQuery),
          shopifyInstallComplete: (appKey, rawQuery, digest, budgetMs) =>
            shopify.installComplete(env, appKey, rawQuery, digest, budgetMs),
          shopifyWebhookVerify: (appKey, headersJson, rawBodyBase64) =>
            shopify.webhookVerify(env, appKey, headersJson, rawBodyBase64),
        },
        // The ConnectorBroker lease: the lab's login takes any password, so the grant is
        // the one fixed lab value (the real lease is proved by lab:edge-workers).
        database: createConnectorDatabase(
          binding,
          {
            neonLease: async () =>
              JSON.stringify({ schemaVersion: 1, password: env.LAB_LEASE_PASSWORD }),
          },
          connectorDriver,
          Date.now,
          NoSocket,
        ),
      });
      return handler.fetch(built);
    }
    const route = url.origin === env.LAB_API_ORIGIN ? apiRoute.exec(url.pathname)?.[1] : undefined;
    if (!route) return new Response(null, { status: 404 });
    const configurationJson = JSON.stringify({
      schemaVersion: 1,
      mode: "https",
      origin: env.LAB_API_ORIGIN,
    });
    const now = () => Date.now();
    const pool = linkingPool(env);
    const kernel = createConnectionKernel();
    const guard = createStandaloneRequestGuard(configurationJson, now);
    if (route === "connections")
      return guard.handle(built, "connections", (context) =>
        executeWorkspaceConnections(pool, now, kernel, context),
      );
    const selected =
      route === "store-links" ? "apply" : route === "store-links/preview" ? "preview" : "status";
    const linking = createStandaloneStoreLinkingExecution({
      configurationJson,
      pool,
      now,
      connections: kernel,
    });
    return guard.handle(built, selected, (context) => linking.execute(selected, context));
  }
}
