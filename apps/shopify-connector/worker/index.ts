// morrow-<env>-connector (M2 PR-2; ADR-0022 item 6; ADR-0008 as amended): the wrangler
// `main`, replacing the P04.T02a placeholder. Bindings map to the connector once per env
// object (isolate); any problem keeps the deny-all instance: 503 on every path, and
// /healthz answers ready false. It binds MORROW_ENVIRONMENT, the reviewed identifiers
// (CONNECTOR_CONFIGURATION_JSON, MORROW_DATABASE_BINDING_JSON), the broker's
// ConnectorBroker entrypoint and its two ingress rate limits; no secret and no Shopify
// library (ADR-0008 items 1-2).
import { createConnectorHandler } from "./connector.js";
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
  async fetch(request: Request, env: unknown): Promise<Response> {
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
      return await selected.handler.fetch(request);
    } catch {
      return connectorJson(503, { code: "connector_unavailable" });
    }
  },
};
