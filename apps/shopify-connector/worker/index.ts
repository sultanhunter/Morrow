// morrow-<env>-connector (M2 PR-2; ADR-0022 item 6; ADR-0008 as amended): the wrangler
// `main`, replacing the P04.T02a placeholder. Bindings map to the connector once per env
// object (isolate); any problem keeps the deny-all instance: 503 on every path, and
// /healthz answers ready false. It binds MORROW_ENVIRONMENT, the reviewed identifiers
// (CONNECTOR_CONFIGURATION_JSON, MORROW_DATABASE_BINDING_JSON), the broker's
// ConnectorBroker entrypoint and its two ingress rate limits; no secret and no Shopify
// library (ADR-0008 items 1-2). M2 PR-3: webhooks are applied after the response
// (waitUntil), and a cron trigger runs the ids-only re-drives (an unbound connector does
// nothing). fix-connector-cron-latency (worker/cron.ts): scheduled() waits for the re-drives
// in the ConnectorCron Durable Object, created beside the database, instead of running them
// wherever Cloudflare runs the cron.
import { DurableObject } from "cloudflare:workers";
import { createConnectorHandler, type ConnectorContext } from "./connector.js";
import { forwardConnectorCron, type ConnectorCronOutcome } from "./cron.js";
import { createConnectorDatabase } from "./database.js";
import { mapConnectorEnvironment, type ConnectorEnvironmentCode } from "./environment.js";
import { connectorJson } from "./pages.js";

interface Selected {
  readonly handler: ReturnType<typeof createConnectorHandler> | null;
  readonly health: (() => Promise<boolean>) | null;
}
const selections = new WeakMap<object, Selected>();
const denied: Selected = Object.freeze({ handler: null, health: null });
function unbound(code: ConnectorEnvironmentCode | "CONNECTOR_ENV_COMPOSITION_INVALID"): Selected {
  console.log(JSON.stringify({ event: "morrow_connector_unbound", code }));
  return denied;
}
function select(env: unknown): Selected {
  if (env === null || typeof env !== "object") return denied;
  const existing = selections.get(env);
  if (existing) return existing;
  let selected: Selected;
  const mapped = mapConnectorEnvironment(env);
  if (!mapped.ok) selected = unbound(mapped.code);
  else
    try {
      const broker = mapped.broker;
      selected = Object.freeze({
        handler: createConnectorHandler({
          configuration: mapped.configuration,
          broker,
          database: createConnectorDatabase(mapped.binding, broker),
          limiters: mapped.limiters,
        }),
        health: () => broker.health(),
      });
    } catch {
      selected = unbound("CONNECTOR_ENV_COMPOSITION_INVALID");
    }
  selections.set(env, selected);
  return selected;
}
async function ready(selected: Selected): Promise<boolean> {
  if (!selected.health) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      selected.health(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: ConnectorContext): Promise<Response> {
    const selected = select(env);
    let pathname = "";
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      pathname = "";
    }
    if (pathname === "/healthz") {
      if (request.method !== "GET") return connectorJson(405, { code: "method_not_allowed" });
      return connectorJson(200, {
        schemaVersion: 1,
        service: "connector",
        ready: await ready(selected),
      });
    }
    if (!selected.handler) return connectorJson(503, { code: "connector_unavailable" });
    try {
      return await selected.handler.fetch(request, ctx);
    } catch {
      return connectorJson(503, { code: "connector_unavailable" });
    }
  },
  // The re-drives run in the object, awaited (not handed to waitUntil, whose 30 s after the
  // handler returns could cut a 60 s run). An unbound connector touches nothing.
  async scheduled(_controller: unknown, env: unknown, _ctx: unknown): Promise<void> {
    if (!select(env).handler) return;
    await forwardConnectorCron(env);
  },
};

// The cron's Durable Object (CONNECTOR_CRON; one object, by a fixed name): one method, which
// runs the re-drives with this Worker's own bindings and answers a closed outcome; the
// counts stay in its morrow_connector_redrive line. A second run while one is in progress
// is "busy". It keeps no storage.
export class ConnectorCron extends DurableObject {
  #running = false;
  async redrive(): Promise<ConnectorCronOutcome> {
    const selected = select(this.env);
    if (!selected.handler) return "unbound";
    if (this.#running) return "busy";
    this.#running = true;
    try {
      await selected.handler.redrive();
      return "ran";
    } finally {
      this.#running = false;
    }
  }
}
