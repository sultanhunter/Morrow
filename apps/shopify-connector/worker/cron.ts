// The connector's cron, run beside the database (fix-connector-cron-latency;
// docs/briefs/fix-connector-cron-latency.md). Cloudflare's placement moves only fetch
// handlers: a scheduled handler runs on whichever machine Cloudflare picks, and the
// ConnectorBroker RPCs it makes run on that same machine. The first cron after the
// shop-specific webhooks (2026-10-25 12:41 UTC) ran far from Neon's us-east-1, and every
// transaction (about 13 sequential round trips against a 3000 ms budget) ran out of time:
// all four steps unavailable.
//
// scheduled() therefore hands each run to one Durable Object, ConnectorCron (worker/index.ts),
// bound as CONNECTOR_CRON in every environment and addressed by one fixed name. Its first
// get() carries the location hint of the Neon region (`locationHint`; scripts/edge.mjs ties
// it to infra/environments/staging.json's neon.region_id), so Cloudflare creates it there;
// the run, its database transactions and its broker RPCs then start beside the database,
// and the existing budgets hold. The object is reachable only through this Worker's own
// namespace binding: no route, hostname, secret, grant or caller input reaches it, and it
// stores nothing. A missing or malformed binding runs nothing (default deny), with one
// fixed-code morrow_connector_cron line; so does an object that fails, is busy or does not
// answer within `waitMs`. Nothing else crosses: the object answers one closed outcome.
// This module imports nothing from the runtime, so tests and scripts/edge.mjs read it as is.

export const connectorCron = Object.freeze({
  /** The namespace binding (scripts/edge.mjs edgeConnectorDurableObjects). */
  binding: "CONNECTOR_CRON",
  className: "ConnectorCron",
  /** The one object every run uses; a constant, never derived from input. */
  objectName: "redrive",
  /** Eastern North America: the region of Neon's aws-us-east-1 (staging.json). */
  locationHint: "enam",
  /**
   * How long scheduled() waits for the object: the run's own deadline (60 s,
   * connectorBudgets.redriveMs) plus room for the steps that started before it.
   */
  waitMs: 120000,
});
export const connectorCronOutcomes = Object.freeze(["ran", "unbound", "busy"] as const);
export type ConnectorCronOutcome = (typeof connectorCronOutcomes)[number];
export type ConnectorCronForward = ConnectorCronOutcome | "object_unbound" | "unavailable";

/** The part of a Durable Object namespace and stub the cron uses. */
export interface ConnectorCronStub {
  redrive(): Promise<unknown>;
}
export interface ConnectorCronNamespace {
  idFromName(name: string): unknown;
  get(id: unknown, options: { locationHint: string }): ConnectorCronStub;
}

const log = (code: string) => console.log(JSON.stringify({ event: "morrow_connector_cron", code }));

// The binding as an own data property with both functions, or null.
export function connectorCronNamespace(env: unknown): ConnectorCronNamespace | null {
  try {
    if (env === null || typeof env !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(env, connectorCron.binding);
    if (!descriptor || !("value" in descriptor)) return null;
    const value: unknown = descriptor.value;
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
    const namespace = value as Partial<ConnectorCronNamespace>;
    if (typeof namespace.idFromName !== "function" || typeof namespace.get !== "function")
      return null;
    return namespace as ConnectorCronNamespace;
  } catch {
    return null;
  }
}

/**
 * One cron run, in the object. Never throws; anything but a completed run logs one
 * fixed-code line. A late answer is discarded (the object finishes on its own).
 */
export async function forwardConnectorCron(
  env: unknown,
  waitMs: number = connectorCron.waitMs,
): Promise<ConnectorCronForward> {
  const namespace = connectorCronNamespace(env);
  if (!namespace) {
    log("CRON_UNBOUND");
    return "unbound";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: unknown;
  try {
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("CONNECTOR_CRON_LATE")), waitMs);
    });
    void stopped.catch(() => {});
    const pending = Promise.resolve().then(() =>
      namespace
        .get(namespace.idFromName(connectorCron.objectName), {
          locationHint: connectorCron.locationHint,
        })
        .redrive(),
    );
    void pending.catch(() => {});
    outcome = await Promise.race([pending, stopped]);
  } catch {
    log("CRON_OBJECT_UNAVAILABLE");
    return "unavailable";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (outcome === "ran") return "ran";
  if (outcome === "busy") {
    log("CRON_BUSY");
    return "busy";
  }
  if (outcome === "unbound") {
    log("CRON_OBJECT_UNBOUND");
    return "object_unbound";
  }
  log("CRON_OBJECT_UNAVAILABLE");
  return "unavailable";
}
