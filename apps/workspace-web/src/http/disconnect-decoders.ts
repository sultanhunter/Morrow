// "Disconnect store": closed decoders of the connection routes' replies (internal JSON
// between the api Worker and this SPA; docs/contracts/work-api.md "Connection routes"). A
// body that does not match exactly decodes to null, which the work outcome mapping turns
// into an unconfirmed read or an uncertain command, never a guess. No reason text, token or
// credential is ever read from these bodies.
import type { ConnectionDisconnectView, DisconnectResultView } from "@morrow/workspace-ui";
import { isId } from "./client";
import { isUtcTime } from "./work-decoders";

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keysOf = (value: Json, required: readonly string[], optional: readonly string[] = []) => {
  const keys = Object.keys(value);
  return (
    required.every((k) => keys.includes(k)) &&
    keys.every((k) => required.includes(k) || optional.includes(k))
  );
};
const installationStatuses = ["linked", "suspended", "uninstalled"] as const;
const setters = ["human", "system", "operator"] as const;
const reasonCodePattern = /^[a-z][a-z0-9_]{2,63}$/;

/** GET /workspace/:ws/connections/:connectionId/disconnect. */
export function decodeDisconnectStatus(
  body: unknown,
  connectionId: string,
): ConnectionDisconnectView | null {
  if (
    !record(body) ||
    !keysOf(body, [
      "schemaVersion",
      "connectionId",
      "storeId",
      "installationStatus",
      "stop",
      "actions",
    ]) ||
    body.schemaVersion !== 1 ||
    body.connectionId !== connectionId ||
    !isId(body.storeId) ||
    typeof body.installationStatus !== "string" ||
    !(installationStatuses as readonly string[]).includes(body.installationStatus)
  )
    return null;
  const a = body.actions;
  if (!record(a) || !keysOf(a, ["disconnect"]) || typeof a.disconnect !== "boolean") return null;
  let stop: ConnectionDisconnectView["stop"] = null;
  if (body.stop !== null) {
    const s = body.stop;
    if (
      !record(s) ||
      !keysOf(s, ["setBy", "reasonCode", "createdAt"]) ||
      typeof s.setBy !== "string" ||
      !(setters as readonly string[]).includes(s.setBy) ||
      typeof s.reasonCode !== "string" ||
      !reasonCodePattern.test(s.reasonCode) ||
      !isUtcTime(s.createdAt)
    )
      return null;
    stop = {
      setBy: s.setBy as (typeof setters)[number],
      reasonCode: s.reasonCode,
      createdAt: s.createdAt,
    };
  }
  const installationStatus = body.installationStatus as (typeof installationStatuses)[number];
  // Only a linked connection with no stop can be disconnected.
  if (a.disconnect && (stop !== null || installationStatus !== "linked")) return null;
  return {
    connectionId,
    storeId: body.storeId,
    installationStatus,
    stop,
    actions: { disconnect: a.disconnect },
  };
}

/** POST /workspace/:ws/connections/:connectionId/disconnect (200, or a replay). */
export function decodeDisconnectResult(
  body: unknown,
  connectionId: string,
): DisconnectResultView | null {
  if (
    !record(body) ||
    !keysOf(
      body,
      [
        "schemaVersion",
        "status",
        "killSwitchRecordId",
        "priorStateObserved",
        "stopId",
        "connectionId",
        "storeId",
        "installationId",
        "installation",
        "endReason",
        "credential",
      ],
      ["replayed"],
    ) ||
    body.schemaVersion !== 1 ||
    body.status !== "disconnected" ||
    body.connectionId !== connectionId ||
    !isId(body.killSwitchRecordId) ||
    (body.priorStateObserved !== "active" && body.priorStateObserved !== "already_stopped") ||
    (body.stopId !== null && !isId(body.stopId)) ||
    (body.credential !== "destroyed" && body.credential !== "pending") ||
    ("replayed" in body && body.replayed !== true)
  )
    return null;
  return { priorStateObserved: body.priorStateObserved, credential: body.credential };
}
