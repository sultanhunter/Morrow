const environmentNames = ["development", "staging", "production"] as const;
const serviceProfiles = [
  "api",
  "workers",
  "connector",
  "credential-broker",
  "task-execution",
  "deployment",
  "recovery",
] as const;

export const operationalCodes = [
  "DEPENDENCY_UNAVAILABLE",
  "CREDENTIAL_ROTATION_STARTED",
  "CREDENTIAL_ROTATION_VERIFIED",
  "CREDENTIAL_ROTATION_PROMOTED",
  "CREDENTIAL_ROTATION_FAILED",
  "WORKER_CONNECTION_LOST",
  "WORKER_CONNECTION_RECOVERED",
  "ACTIVATION_HELD",
  "RESTORE_QUARANTINED",
  "RESTORE_INTEGRITY_FAILED",
  "RESTORE_INTEGRITY_VERIFIED",
] as const;
export interface OperationalEvent {
  schemaVersion: 1;
  environment: (typeof environmentNames)[number];
  service: (typeof serviceProfiles)[number];
  code: (typeof operationalCodes)[number];
  correlationId: string;
  at: string;
  durationMs?: number;
}
const fields = new Set([
  "schemaVersion",
  "environment",
  "service",
  "code",
  "correlationId",
  "at",
  "durationMs",
]);
// Reject arbitrary strings/fields before serialization; never sanitize an Error
// by logging its message. Producers map errors to reviewed fixed codes.
export function encodeOperationalEvent(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("INVALID_OPERATIONAL_EVENT");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).some((field) => typeof field !== "string" || !fields.has(field)) ||
    Object.values(descriptors).some((field) => !Object.hasOwn(field, "value"))
  )
    throw Error("INVALID_OPERATIONAL_EVENT");
  const event = Object.fromEntries(
    Object.entries(descriptors).map(([key, value]) => [key, value.value]),
  );
  if (
    event.schemaVersion !== 1 ||
    !environmentNames.some((value) => value === event.environment) ||
    !serviceProfiles.some((value) => value === event.service) ||
    !operationalCodes.some((value) => value === event.code) ||
    typeof event.correlationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(event.correlationId) ||
    typeof event.at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.at) ||
    !Number.isFinite(Date.parse(event.at)) ||
    new Date(event.at).toISOString() !== event.at ||
    (Object.hasOwn(event, "durationMs") &&
      (typeof event.durationMs !== "number" ||
        !Number.isSafeInteger(event.durationMs) ||
        event.durationMs < 0 ||
        event.durationMs > 86400000))
  )
    throw Error("INVALID_OPERATIONAL_EVENT");
  return JSON.stringify(event);
}
// Only these fixed bounded dimensions; correlation IDs never become metrics.
export function operationalMetricDimensions(input: unknown): Record<string, string> {
  const event = JSON.parse(encodeOperationalEvent(input)) as OperationalEvent;
  return { Environment: event.environment, Service: event.service, Code: event.code };
}
