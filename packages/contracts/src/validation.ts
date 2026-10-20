import {
  validators,
  currentDefinitionSelectors,
  capabilityBodySelectors,
  currentBillingDefinitionSelectors,
  eventPayloadSelectors,
  validateEventPayload as registeredEventPayload,
} from "./generated/runtime-validators.mjs";
import type {
  CapabilityId,
  CapabilityInput,
  CapabilityOutput,
  CurrentBillingDefinitionName,
  CurrentDefinitionName,
  EventPayloadOf,
  EventType,
} from "./generated/domain";
/** Exact schema layers. Product code uses the effective (current) selectors below. */
export type DefinitionSchema = "core" | "billing" | "core-v1.1" | "billing-v1.1";
const definitionSchemas: readonly string[] = ["core", "billing", "core-v1.1", "billing-v1.1"];
function valid(selector: string, value: unknown): boolean {
  if (!Object.hasOwn(validators, selector)) return false;
  return validators[selector]!(value) === true;
}
function selected(selectors: Readonly<Record<string, string>>, key: string, value: unknown) {
  return Object.hasOwn(selectors, key) && valid(selectors[key]!, value);
}
/** Validates the effective input body: the v1.1 override when one exists, else v1. */
export function validateCapabilityInput<K extends CapabilityId>(
  id: K,
  value: unknown,
): value is CapabilityInput<K> {
  return selected(capabilityBodySelectors, `${id}.input`, value);
}
/** Validates the effective output body: the v1.1 override when one exists, else v1. */
export function validateCapabilityOutput<K extends CapabilityId>(
  id: K,
  value: unknown,
): value is CapabilityOutput<K> {
  return selected(capabilityBodySelectors, `${id}.output`, value);
}
/** Exact selector, for the frozen baseline, history and tests. */
export function validateDefinition(
  schema: DefinitionSchema,
  name: string,
  value: unknown,
): boolean {
  return definitionSchemas.includes(schema) && valid(`${schema}:${name}`, value);
}
/**
 * The additive event registry (ADR-0016 item 6; P01.T02c §8): true when
 * `eventType` is registered, `aggregateType` is its row's and `payload` is valid
 * against its row's payload definition. A null (redacted) payload is not a payload.
 */
export function validateEventPayload<K extends EventType>(
  eventType: K,
  aggregateType: unknown,
  payload: unknown,
): payload is EventPayloadOf<K> & object;
export function validateEventPayload(
  eventType: unknown,
  aggregateType: unknown,
  payload: unknown,
): boolean;
export function validateEventPayload(eventType: unknown, aggregateType: unknown, payload: unknown) {
  return registeredEventPayload(eventType, aggregateType, payload);
}
/** True when `eventType` is registered with exactly this `aggregateType`. */
export function eventRegistered(eventType: unknown, aggregateType: unknown): boolean {
  return (
    typeof eventType === "string" &&
    Object.hasOwn(eventPayloadSelectors, eventType) &&
    eventPayloadSelectors[eventType]!.aggregateType === aggregateType
  );
}
type Tenancy = { organizationId: string; workspaceId: string; storeId: string | null };
// An EventEnvelope@2 that already passed its schema: a registered type and
// aggregate, a registered payload unless it was nulled for this viewer (the
// schema nulls payload and payloadRef together), and a payloadRef bound to this
// event (§8: the envelope's organization, workspace and store, and id = eventId).
function registeredEnvelope(envelope: unknown): boolean {
  const e = envelope as Tenancy & {
    eventId: string;
    eventType: unknown;
    aggregateType: unknown;
    payload: unknown;
    payloadRef: (Tenancy & { id: string }) | null;
  };
  const ref = e.payloadRef;
  return (
    eventRegistered(e.eventType, e.aggregateType) &&
    (e.payload === null || registeredEventPayload(e.eventType, e.aggregateType, e.payload)) &&
    (ref === null ||
      (ref.organizationId === e.organizationId &&
        ref.workspaceId === e.workspaceId &&
        ref.storeId === e.storeId &&
        ref.id === e.eventId))
  );
}
// An AskAdminReadRecord that already passed its schema (ADR-0016 item 5): an
// admin read never audits the reader's own Ask, and a list names each Ask once.
function adminReadRecord(record: unknown): boolean {
  const r = record as {
    readerPrincipalId: string;
    readKind: string;
    askOwnerPrincipalId?: string;
    asks?: { conversationId: string; askOwnerPrincipalId: string }[];
  };
  if (r.readKind !== "list") return r.askOwnerPrincipalId !== r.readerPrincipalId;
  const asks = r.asks ?? [];
  return (
    asks.every((a) => a.askOwnerPrincipalId !== r.readerPrincipalId) &&
    new Set(asks.map((a) => a.conversationId)).size === asks.length
  );
}
// A ResourceRef that already passed its v1.1 schema (ADR-0022 item 2): a store
// resource names the store itself, so its id is its storeId. The schema already
// makes storeId and connectionId non-null for kind store; JSON Schema cannot
// compare two properties, so the equality is checked here.
const storeBound = (ref: unknown) => {
  const r = ref as { kind: string; id: string; storeId: string | null };
  return r.kind !== "store" || r.id === r.storeId;
};
const scopeStoresBound = (scope: unknown) =>
  (scope as { resources: readonly unknown[] }).resources.every(storeBound);
/**
 * Effective definition: the newest core layer that defines the name. For
 * EventEnvelope (@2), and a StreamFrame carrying one, this is the schema plus
 * the event registry selector and the payloadRef binding; for
 * AskAdminReadRecord, the schema plus its reader and uniqueness rules; for
 * ResourceRef, Scope and Grant (v1.1), the schema plus the store rule (a store
 * resource's id is its storeId), applied to every resource a scope or grant
 * names. Product code validates these six only here, never by their exact
 * selectors.
 */
export function validateCurrentDefinition(name: CurrentDefinitionName, value: unknown): boolean {
  if (!selected(currentDefinitionSelectors, name, value)) return false;
  if (name === "EventEnvelope") return registeredEnvelope(value);
  if (name === "StreamFrame") {
    const frame = value as { kind: string; envelope?: unknown };
    return frame.kind !== "event" || registeredEnvelope(frame.envelope);
  }
  if (name === "AskAdminReadRecord") return adminReadRecord(value);
  if (name === "ResourceRef") return storeBound(value);
  if (name === "Scope") return scopeStoresBound(value);
  if (name === "Grant") return scopeStoresBound((value as { scope: unknown }).scope);
  return true;
}
/** Effective billing definition: the newest billing layer that defines the name (ADR-0015). */
export function validateCurrentBillingDefinition(
  name: CurrentBillingDefinitionName,
  value: unknown,
): boolean {
  return selected(currentBillingDefinitionSelectors, name, value);
}
