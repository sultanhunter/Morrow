import { createHash, randomUUID } from "node:crypto";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import type {
  Core_ActorRef,
  Core_PolicyDecision,
  Core_GrantRef,
  Core_MandateRef,
  CurrentDefinitionName,
  Current_Grant,
  Current_ResourceRef,
  Current_Scope,
} from "@morrow/contracts";
import type { PermissionRequest, PermissionVerb } from "./index";
import type {
  AgentAuthorityReader,
  AgentPermissionResult,
  AgentAuthorityLineage,
  AgentExecutionObligation,
  CurrentActorAuthority,
  PrincipalWorkEnvelope,
  DelegationHop,
  DispatcherAuthority,
  InstalledAgentAuthority,
  ResolvedGrantRecord,
  ResolvedMandateRecord,
  CurrentOperationConstraints,
  DelegationAuthorityFacts,
  AutomationAuthorityFacts,
  DelegationEligibilityInput,
  AutomationEligibilityInput,
} from "./agent-authority-facts";
import catalogue from "../../../docs/contracts/capabilities.json";
export type * from "./agent-authority-facts";

export class AgentAuthorityError extends Error {
  constructor(readonly code: "AGENT_POLICY_INPUT_INVALID" | "AGENT_POLICY_AUTHORITY_UNAVAILABLE") {
    super(code);
    this.name = "AgentAuthorityError";
  }
}
// Current definitions (ADR-0022 item 2): grants, scopes and resources may name the store
// resource. AgentInstallation and AutomationMandate are unchanged v1 definitions.
const valid = (name: CurrentDefinitionName, value: unknown) =>
  validateCurrentDefinition(name, value);
const verbs = ["view", "propose", "approve", "execute", "delegate", "administer"];
const capabilities = new Map(catalogue.capabilities.map((c) => [c.id, c]));
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function scalarString(value: string, budget: { nodes: number; chars: number }) {
  budget.chars += value.length;
  if (value.length > 65536 || budget.chars > 2 * 1024 * 1024) throw Error();
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw Error();
    } else if (code >= 0xdc00 && code <= 0xdfff) throw Error();
  }
}
// Only locally parsed JSON or locally constructed results reach this helper.
// Public boundaries reject non-string values before inspecting them, so proxies,
// getters and caller toJSON methods cannot run. Freeze before an async boundary.
function snapshot(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { nodes: 0, chars: 0 },
): Json {
  if (++budget.nodes > 200000 || depth > 32) throw Error();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    scalarString(value, budget);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw Error();
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) throw Error();
  const array = Array.isArray(value),
    proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
    throw Error();
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((k) => typeof k !== "string")) throw Error();
  let result: Json;
  if (array) {
    const length = descriptors.length?.value as unknown;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 10000 ||
      keys.length !== length + 1
    )
      throw Error();
    const out: Json[] = [];
    for (let i = 0; i < length; i++) {
      const d = descriptors[String(i)];
      if (!d || !d.enumerable || !("value" in d)) throw Error();
      out.push(snapshot(d.value, depth + 1, seen, budget));
    }
    result = out;
  } else {
    const out: { [key: string]: Json } = {};
    for (const key of keys as string[]) {
      scalarString(key, budget);
      const d = descriptors[key];
      if (!d || !d.enumerable || !("value" in d)) throw Error();
      Object.defineProperty(out, key, {
        value: snapshot(d.value, depth + 1, seen, budget),
        enumerable: true,
      });
    }
    result = out;
  }
  seen.delete(value);
  return Object.freeze(result) as Json;
}
function parseJsonText(value: unknown): Json {
  // This typeof check must precede coercion, reflection or serialization. The
  // length bound applies before JSON.parse allocates or examines nested values.
  if (typeof value !== "string" || value.length > 2 * 1024 * 1024) throw Error();
  return snapshot(JSON.parse(value));
}
function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]!))
      .join(",") +
    "}"
  );
}
export function canonicalPayloadDigest(value: unknown): string {
  try {
    return digestParsed(parseJsonText(value));
  } catch {
    throw new AgentAuthorityError("AGENT_POLICY_INPUT_INVALID");
  }
}
function digestParsed(value: Json): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw Error();
}
function boundedArray(
  value: unknown,
  max: number,
  predicate: (x: unknown) => boolean,
  min = 0,
): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max || !value.every(predicate))
    throw Error();
}
const nullableId = (v: unknown) => v === null || valid("Id", v);
const time = (v: unknown) =>
  valid("UtcTime", v) && typeof v === "string" && Number.isFinite(Date.parse(v));
const nullableTime = (v: unknown) => v === null || time(v);
const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
function uniqueStrings(value: unknown, max: number, predicate: (x: unknown) => boolean, min = 0) {
  boundedArray(value, max, predicate, min);
  if (new Set(value).size !== value.length) throw Error();
}
function parseOperation(v: unknown): PermissionRequest {
  closed(v, ["capabilityId", "verb", "resource", "accountId", "fields"]);
  if (
    !valid("CapabilityId", v.capabilityId) ||
    typeof v.verb !== "string" ||
    !verbs.includes(v.verb) ||
    !valid("ResourceRef", v.resource) ||
    !nullableId(v.accountId)
  )
    throw Error();
  uniqueStrings(v.fields, 1000, (x) => valid("FieldPath", x), 1);
  return v as unknown as PermissionRequest;
}
function parseCurrent(v: unknown): CurrentActorAuthority {
  const flags = ["principalActive", "organizationActive", "workspaceActive", "membershipActive"];
  closed(v, ["actor", "policyRevision", "grantsRevision", "grants", ...flags]);
  if (
    !valid("ActorRef", v.actor) ||
    !valid("Revision", v.policyRevision) ||
    !valid("Revision", v.grantsRevision) ||
    flags.some((f) => typeof v[f] !== "boolean")
  )
    throw Error();
  boundedArray(v.grants, 1000, (g) => valid("Grant", g));
  if (new Set((v.grants as Current_Grant[]).map((g) => g.id)).size !== v.grants.length)
    throw Error();
  return v as unknown as CurrentActorAuthority;
}
function parseRecord(
  v: unknown,
  kind: "Grant" | "AutomationMandate",
): ResolvedGrantRecord | ResolvedMandateRecord {
  closed(v, ["organizationId", "workspaceId", "storeId", "recordRevision", "payload"]);
  if (
    !valid("Id", v.organizationId) ||
    !valid("Id", v.workspaceId) ||
    !nullableId(v.storeId) ||
    !valid("Revision", v.recordRevision) ||
    !valid(kind, v.payload)
  )
    throw Error();
  return v as unknown as ResolvedGrantRecord | ResolvedMandateRecord;
}
function parseInstalled(v: unknown): InstalledAgentAuthority {
  closed(v, ["installation", "current", "owner", "grantRecords"]);
  if (!valid("AgentInstallation", v.installation)) throw Error();
  parseCurrent(v.current);
  parseCurrent(v.owner);
  boundedArray(v.grantRecords, 1000, () => true);
  for (const record of v.grantRecords) parseRecord(record, "Grant");
  return v as unknown as InstalledAgentAuthority;
}
function parseDispatcher(v: unknown): DispatcherAuthority {
  closed(v, ["kind", "current", "installed"]);
  parseCurrent(v.current);
  if (v.kind === "builtin_coordinator") {
    if (v.installed !== null) throw Error();
  } else if (v.kind === "installed_agent") parseInstalled(v.installed);
  else throw Error();
  return v as unknown as DispatcherAuthority;
}
function parseEnvelope(v: unknown): PrincipalWorkEnvelope {
  closed(v, [
    "schemaVersion",
    "id",
    "revision",
    "taskId",
    "taskRevision",
    "organizationId",
    "workspaceId",
    "requester",
    "authorizer",
    "capabilityIds",
    "verbs",
    "scope",
    "validFrom",
    "expiresAt",
    "revokedAt",
    "maximumDepth",
    "maximumChildren",
  ]);
  if (
    v.schemaVersion !== 1 ||
    ![v.id, v.taskId, v.organizationId, v.workspaceId].every((x) => valid("Id", x)) ||
    ![v.revision, v.taskRevision].every((x) => valid("Revision", x)) ||
    !valid("ActorRef", v.requester) ||
    !valid("ActorRef", v.authorizer) ||
    !valid("Scope", v.scope) ||
    !time(v.validFrom) ||
    !time(v.expiresAt) ||
    !nullableTime(v.revokedAt) ||
    !count(v.maximumDepth, 8) ||
    !count(v.maximumChildren, 32)
  )
    throw Error();
  uniqueStrings(v.capabilityIds, 1000, (x) => valid("CapabilityId", x), 1);
  uniqueStrings(v.verbs, 6, (x) => typeof x === "string" && verbs.includes(x), 1);
  return v as unknown as PrincipalWorkEnvelope;
}
function parseHop(v: unknown): DelegationHop {
  closed(v, [
    "id",
    "revision",
    "parentTaskId",
    "parentTaskRevision",
    "parentTaskResource",
    "childTaskId",
    "childTaskRevision",
    "parentEnvelopeId",
    "parentEnvelopeRevision",
    "childEnvelopeId",
    "childEnvelopeRevision",
    "dispatcher",
    "recipient",
    "capabilityIds",
    "verbs",
    "scope",
    "validFrom",
    "expiresAt",
    "revokedAt",
    "parentChildCount",
  ]);
  if (
    ![v.id, v.parentTaskId, v.childTaskId, v.parentEnvelopeId, v.childEnvelopeId].every((x) =>
      valid("Id", x),
    ) ||
    ![
      v.revision,
      v.parentTaskRevision,
      v.childTaskRevision,
      v.parentEnvelopeRevision,
      v.childEnvelopeRevision,
    ].every((x) => valid("Revision", x)) ||
    !valid("ActorRef", v.recipient) ||
    !valid("Scope", v.scope) ||
    !time(v.validFrom) ||
    !time(v.expiresAt) ||
    !nullableTime(v.revokedAt) ||
    !count(v.parentChildCount, 32)
  )
    throw Error();
  if (!valid("ResourceRef", v.parentTaskResource)) throw Error();
  parseDispatcher(v.dispatcher);
  uniqueStrings(v.capabilityIds, 1000, (x) => valid("CapabilityId", x), 1);
  uniqueStrings(v.verbs, 6, (x) => typeof x === "string" && verbs.includes(x), 1);
  return v as unknown as DelegationHop;
}
function parseConstraints(v: unknown): CurrentOperationConstraints {
  closed(v, ["resource", "accountId", "providerAllowed", "entitlementAllowed"]);
  if (
    !valid("ResourceRef", v.resource) ||
    !nullableId(v.accountId) ||
    typeof v.providerAllowed !== "boolean" ||
    typeof v.entitlementAllowed !== "boolean"
  )
    throw Error();
  return v as unknown as CurrentOperationConstraints;
}
function parseDelegation(v: unknown): DelegationAuthorityFacts {
  closed(v, ["envelope", "origin", "hops", "executor", "constraints"]);
  parseEnvelope(v.envelope);
  parseCurrent(v.origin);
  boundedArray(v.hops, 8, () => true, 1);
  for (const h of v.hops) parseHop(h);
  parseInstalled(v.executor);
  parseConstraints(v.constraints);
  return v as unknown as DelegationAuthorityFacts;
}
function parseAutomation(v: unknown): AutomationAuthorityFacts {
  closed(v, ["mandate", "executor", "constraints"]);
  parseRecord(v.mandate, "AutomationMandate");
  parseInstalled(v.executor);
  parseConstraints(v.constraints);
  return v as unknown as AutomationAuthorityFacts;
}
const sameActor = (a: Core_ActorRef, b: Core_ActorRef) =>
  canonical(a as unknown as Json) === canonical(b as unknown as Json);
const sameResource = (a: Current_ResourceRef, b: Current_ResourceRef) =>
  canonical(a as unknown as Json) === canonical(b as unknown as Json);
const samePayload = (a: unknown, b: unknown) => canonical(a as Json) === canonical(b as Json);
const context = (a: Core_ActorRef, r: Current_ResourceRef) =>
  a.organizationId === r.organizationId && a.workspaceId === r.workspaceId;
const human = (a: Core_ActorRef) =>
  a.kind === "human" &&
  a.membershipId !== null &&
  a.workspaceId !== null &&
  a.installationId === null &&
  a.mandateId === null;
const agent = (a: Core_ActorRef, installationId: string | null) =>
  a.kind === "agent" &&
  a.membershipId === null &&
  a.workspaceId !== null &&
  a.installationId === installationId &&
  a.mandateId === null;
const live = (a: CurrentActorAuthority, revision: number) =>
  a.principalActive &&
  a.organizationActive &&
  a.workspaceActive &&
  a.policyRevision === revision &&
  a.grantsRevision === revision;
const liveHuman = (a: CurrentActorAuthority, revision: number) =>
  human(a.actor) && a.membershipActive && live(a, revision);
function scopeBound(scope: Current_Scope, r: Current_ResourceRef) {
  return (
    scope.organizationId === r.organizationId &&
    scope.workspaceId === r.workspaceId &&
    scope.resources.every(
      (x) =>
        x.organizationId === scope.organizationId &&
        x.workspaceId === scope.workspaceId &&
        (x.storeId === null || scope.storeIds.includes(x.storeId)),
    )
  );
}
function scopeCovers(scope: Current_Scope, op: PermissionRequest) {
  return (
    scopeBound(scope, op.resource) &&
    (op.resource.storeId === null
      ? scope.storeIds.length === 0
      : scope.storeIds.includes(op.resource.storeId)) &&
    (op.accountId === null
      ? scope.accountIds.length === 0
      : scope.accountIds.includes(op.accountId)) &&
    scope.resources.some((r) => sameResource(r, op.resource)) &&
    op.fields.every((f) => scope.fields.includes(f))
  );
}
function subset(child: Current_Scope, parent: Current_Scope) {
  return (
    child.organizationId === parent.organizationId &&
    child.workspaceId === parent.workspaceId &&
    child.storeIds.every((x) => parent.storeIds.includes(x)) &&
    child.accountIds.every((x) => parent.accountIds.includes(x)) &&
    child.resources.every((x) => parent.resources.some((y) => sameResource(x, y))) &&
    child.fields.every((x) => parent.fields.includes(x))
  );
}
function grantCovers(
  a: CurrentActorAuthority,
  op: PermissionRequest,
  verb: PermissionVerb,
  now: number,
) {
  if (!context(a.actor, op.resource)) return false;
  return a.grants.some(
    (g) =>
      sameActor(g.principal, a.actor) &&
      g.capabilityId === op.capabilityId &&
      g.verbs.includes(verb) &&
      g.revokedAt === null &&
      time(g.validFrom) &&
      Date.parse(g.validFrom) <= now &&
      (g.expiresAt === null || (time(g.expiresAt) && Date.parse(g.expiresAt) > now)) &&
      g.policyRevision <= a.policyRevision &&
      g.issuedBy.organizationId === a.actor.organizationId &&
      (g.issuedBy.workspaceId === null || g.issuedBy.workspaceId === a.actor.workspaceId) &&
      scopeCovers(g.scope, op),
  );
}
function referenceMatches(
  ref: Core_GrantRef | Core_MandateRef,
  record: ResolvedGrantRecord | ResolvedMandateRecord,
) {
  return (
    ref.id === record.payload.id &&
    ref.organizationId === record.organizationId &&
    ref.workspaceId === record.workspaceId &&
    ref.storeId === record.storeId &&
    ref.revision === record.recordRevision &&
    ref.digest === digestParsed(record.payload as unknown as Json)
  );
}
function installedBound(
  a: InstalledAgentAuthority,
  request: PermissionRequest,
  expectedId: string,
  revision: number,
) {
  const i = a.installation;
  if (
    i.id !== expectedId ||
    i.organizationId !== request.resource.organizationId ||
    i.workspaceId !== request.resource.workspaceId ||
    !sameActor(a.owner.actor, i.owner) ||
    a.owner.actor.principalId === a.current.actor.principalId ||
    !context(a.owner.actor, request.resource) ||
    !context(a.current.actor, request.resource) ||
    !agent(a.current.actor, i.id) ||
    !live(a.current, revision) ||
    !liveHuman(a.owner, revision) ||
    i.status !== "active" ||
    i.provisionalExpiresAt !== null ||
    !scopeBound(i.scope, request.resource) ||
    (i.storeId !== null && i.storeId !== request.resource.storeId)
  )
    return false;
  if (
    i.grantRefs.length !== a.grantRecords.length ||
    a.current.grants.length !== a.grantRecords.length ||
    new Set(i.grantRefs.map((g) => g.id)).size !== i.grantRefs.length ||
    new Set(a.grantRecords.map((g) => g.payload.id)).size !== a.grantRecords.length
  )
    return false;
  return a.grantRecords.every((record) => {
    const g = record.payload,
      ref = i.grantRefs.find((x) => x.id === g.id);
    return (
      !!ref &&
      referenceMatches(ref, record) &&
      record.organizationId === i.organizationId &&
      record.workspaceId === i.workspaceId &&
      sameActor(g.principal, a.current.actor) &&
      a.current.grants.some((current) => samePayload(current, g)) &&
      scopeBound(g.scope, request.resource) &&
      (record.storeId === null ||
        (g.scope.storeIds.length === 1 && g.scope.storeIds[0] === record.storeId)) &&
      (i.storeId === null || record.storeId === i.storeId)
    );
  });
}
// Agents never view or execute a human_only capability (ADR-0005). They may only
// propose one, and only where a proposal path exists: a kill switch or a
// reviewed capability. Grants, titles and delegation cannot widen this.
function allowedOperation(op: PermissionRequest) {
  const c = capabilities.get(op.capabilityId);
  return (
    !!c &&
    ["view", "propose", "execute"].includes(op.verb) &&
    op.capabilityId !== "governance.connection.connect" &&
    !c.eligible_principal.startsWith("operator_") &&
    !c.eligible_principal.startsWith("eligible_human_") &&
    (c.executor !== "human_only" || (op.verb === "propose" && (c.kill_switch || c.review_required)))
  );
}
function activeWindow(start: string, end: string, revoked: string | null, now: number) {
  return (
    revoked === null &&
    Date.parse(start) <= now &&
    Date.parse(end) > now &&
    Date.parse(start) < Date.parse(end)
  );
}
function result(
  reason: Core_PolicyDecision["reason"],
  revision: number,
  at: string,
  op: PermissionRequest,
  lineage: AgentAuthorityLineage | null,
  delegated: boolean,
): AgentPermissionResult {
  const allowed = reason === "allowed";
  const obligations: AgentExecutionObligation[] = [];
  if (allowed) {
    obligations.push("recheck_at_dispatch", "qualified_dispatch");
    if (delegated) obligations.push("atomic_delegation_admission");
    const c = capabilities.get(op.capabilityId)!;
    if (op.verb === "execute") {
      if (c.review_required) obligations.push("exact_approval");
      if (["spend", "billable_job"].includes(c.effect)) obligations.push("budget_reservation");
      if (["external_write", "spend", "communication", "billable_job"].includes(c.effect))
        obligations.push("provider_effect_verification");
    }
  }
  const decision = {
    decisionId: randomUUID(),
    allowed,
    reason,
    policyRevision: revision,
    evaluatedAt: at,
    safeMessage: allowed
      ? "Permission is eligible; execution controls remain required."
      : "Current authority does not permit this operation.",
    requiredInputIds: [],
  };
  if (!valid("PolicyDecision", decision)) throw Error();
  return snapshot({
    decision,
    obligations,
    lineage: allowed ? lineage : null,
  }) as unknown as AgentPermissionResult;
}
function evaluateDelegation(
  input: DelegationEligibilityInput,
  f: DelegationAuthorityFacts,
  at: string,
): AgentPermissionResult {
  const op = input.operation,
    e = f.envelope,
    revision = f.origin.policyRevision,
    now = Date.parse(at);
  const deny = (reason: Core_PolicyDecision["reason"]) =>
    result(reason, revision, at, op, null, true);
  if (!allowedOperation(op)) return deny("capability_denied");
  if (
    e.id !== input.envelopeId ||
    e.organizationId !== op.resource.organizationId ||
    e.workspaceId !== op.resource.workspaceId ||
    !context(e.requester, op.resource) ||
    !sameActor(e.requester, e.authorizer) ||
    !sameActor(e.authorizer, f.origin.actor) ||
    !sameResource(f.constraints.resource, op.resource) ||
    f.constraints.accountId !== op.accountId
  )
    return deny("scope_denied");
  if (!liveHuman(f.origin, revision)) return deny("membership_revoked");
  if (
    !activeWindow(e.validFrom, e.expiresAt, e.revokedAt, now) ||
    !e.capabilityIds.includes(op.capabilityId) ||
    !e.verbs.includes(op.verb) ||
    !scopeCovers(e.scope, op)
  )
    return deny("origin_denied");
  if (!grantCovers(f.origin, op, op.verb, now) || !grantCovers(f.origin, op, "delegate", now))
    return deny("capability_denied");
  if (f.hops.length > e.maximumDepth || e.maximumChildren === 0) return deny("origin_denied");
  let parentTask = e.taskId,
    parentTaskRevision = e.taskRevision,
    parentEnvelope = e.id,
    parentEnvelopeRevision = e.revision;
  let previousScope = e.scope,
    previousCaps = e.capabilityIds,
    previousVerbs = e.verbs,
    previousStart = e.validFrom,
    previousEnd = e.expiresAt;
  let previousRecipient: Core_ActorRef | null = null;
  const taskIds = new Set([e.taskId]),
    envelopeIds = new Set([e.id]),
    hopIds = new Set<string>(),
    actorIds = new Set([
      e.requester.principalId,
      f.executor.owner.actor.principalId,
      ...f.hops.flatMap((hop) =>
        hop.dispatcher.kind === "installed_agent"
          ? [hop.dispatcher.installed.owner.actor.principalId]
          : [],
      ),
    ]);
  const dispatchers: Core_ActorRef[] = [];
  for (const hop of f.hops) {
    const dispatcher = hop.dispatcher,
      d = dispatcher.current;
    if (
      hopIds.has(hop.id) ||
      taskIds.has(hop.childTaskId) ||
      envelopeIds.has(hop.childEnvelopeId) ||
      hop.parentTaskId !== parentTask ||
      hop.parentTaskRevision !== parentTaskRevision ||
      hop.parentEnvelopeId !== parentEnvelope ||
      hop.parentEnvelopeRevision !== parentEnvelopeRevision ||
      actorIds.has(d.actor.principalId) ||
      (previousRecipient !== null && !sameActor(previousRecipient, d.actor)) ||
      hop.parentChildCount >= e.maximumChildren ||
      !context(d.actor, op.resource) ||
      !context(hop.recipient, op.resource) ||
      hop.recipient.kind !== "agent" ||
      hop.recipient.membershipId !== null ||
      hop.recipient.mandateId !== null ||
      !scopeBound(hop.scope, op.resource) ||
      !subset(hop.scope, previousScope) ||
      !hop.capabilityIds.every((c) => previousCaps.includes(c)) ||
      !hop.verbs.every((v) => previousVerbs.includes(v)) ||
      !hop.capabilityIds.includes(op.capabilityId) ||
      !hop.verbs.includes(op.verb) ||
      !scopeCovers(hop.scope, op) ||
      !activeWindow(hop.validFrom, hop.expiresAt, hop.revokedAt, now) ||
      Date.parse(hop.validFrom) < Date.parse(previousStart) ||
      Date.parse(hop.expiresAt) > Date.parse(previousEnd)
    )
      return deny("origin_denied");
    const task = hop.parentTaskResource;
    if (
      task.kind !== "task" ||
      task.id !== hop.parentTaskId ||
      task.organizationId !== e.organizationId ||
      task.workspaceId !== e.workspaceId ||
      task.connectionId !== null
    )
      return deny("scope_denied");
    const dispatchOp: PermissionRequest = {
      capabilityId: "workspace.task.delegate",
      verb: "delegate",
      resource: task,
      accountId: null,
      fields: ["taskId", "installationId", "mandate"],
    };
    if (!live(d, revision)) return deny("membership_revoked");
    if (dispatcher.kind === "builtin_coordinator") {
      if (!agent(d.actor, null)) return deny("origin_denied");
    } else {
      if (
        !samePayload(d, dispatcher.installed.current) ||
        d.actor.installationId === null ||
        !installedBound(dispatcher.installed, dispatchOp, d.actor.installationId, revision) ||
        !scopeCovers(dispatcher.installed.installation.scope, dispatchOp) ||
        !grantCovers(dispatcher.installed.owner, op, op.verb, now) ||
        !grantCovers(dispatcher.installed.owner, dispatchOp, "delegate", now)
      )
        return deny("origin_denied");
    }
    if (!grantCovers(d, dispatchOp, "delegate", now)) return deny("capability_denied");
    hopIds.add(hop.id);
    taskIds.add(hop.childTaskId);
    envelopeIds.add(hop.childEnvelopeId);
    actorIds.add(d.actor.principalId);
    dispatchers.push(d.actor);
    parentTask = hop.childTaskId;
    parentTaskRevision = hop.childTaskRevision;
    parentEnvelope = hop.childEnvelopeId;
    parentEnvelopeRevision = hop.childEnvelopeRevision;
    previousScope = hop.scope;
    previousCaps = hop.capabilityIds;
    previousVerbs = hop.verbs;
    previousStart = hop.validFrom;
    previousEnd = hop.expiresAt;
    previousRecipient = hop.recipient;
  }
  if (
    previousRecipient === null ||
    !sameActor(previousRecipient, f.executor.current.actor) ||
    actorIds.has(f.executor.current.actor.principalId) ||
    !installedBound(f.executor, op, input.executorInstallationId, revision)
  )
    return deny("origin_denied");
  if (
    !scopeCovers(f.executor.installation.scope, op) ||
    !grantCovers(f.executor.current, op, op.verb, now) ||
    !grantCovers(f.executor.owner, op, op.verb, now)
  )
    return deny("capability_denied");
  if (!f.constraints.providerAllowed) return deny("provider_denied");
  if (!f.constraints.entitlementAllowed) return deny("entitlement_denied");
  return result(
    "allowed",
    revision,
    at,
    op,
    {
      requester: e.requester,
      authorizer: e.authorizer,
      dispatchers,
      executor: f.executor.current.actor,
      envelopeId: e.id,
      mandateId: null,
    },
    true,
  );
}
function evaluateAutomation(
  input: AutomationEligibilityInput,
  f: AutomationAuthorityFacts,
  at: string,
): AgentPermissionResult {
  const op = input.operation,
    m = f.mandate.payload,
    a = f.executor,
    revision = a.owner.policyRevision,
    now = Date.parse(at);
  const deny = (reason: Core_PolicyDecision["reason"]) =>
    result(reason, revision, at, op, null, false);
  if (!allowedOperation(op)) return deny("capability_denied");
  if (
    m.id !== input.mandateId ||
    m.installationId !== input.executorInstallationId ||
    !sameActor(m.owner, a.installation.owner) ||
    !sameActor(m.owner, a.owner.actor) ||
    a.current.actor.principalId === a.owner.actor.principalId ||
    m.organizationId !== op.resource.organizationId ||
    m.workspaceId !== op.resource.workspaceId ||
    !sameResource(f.constraints.resource, op.resource) ||
    f.constraints.accountId !== op.accountId ||
    f.mandate.organizationId !== m.organizationId ||
    f.mandate.workspaceId !== m.workspaceId ||
    f.mandate.storeId !== m.storeId ||
    f.mandate.recordRevision !== m.revision ||
    (m.storeId !== null && m.storeId !== op.resource.storeId)
  )
    return deny("scope_denied");
  const refs = a.installation.mandateRefs;
  if (
    new Set(refs.map((r) => r.id)).size !== refs.length ||
    refs.filter((r) => r.id === m.id).length !== 1 ||
    !referenceMatches(refs.find((r) => r.id === m.id)!, f.mandate)
  )
    return deny("origin_denied");
  if (!installedBound(a, op, input.executorInstallationId, revision)) return deny("origin_denied");
  if (!activeWindow(m.startsAt, m.expiresAt, m.revokedAt, now)) return deny("mandate_expired");
  if (
    !m.capabilityIds.includes(op.capabilityId) ||
    !scopeCovers(m.scope, op) ||
    !scopeCovers(a.installation.scope, op) ||
    !grantCovers(a.owner, op, op.verb, now) ||
    !grantCovers(a.current, op, op.verb, now)
  )
    return deny("capability_denied");
  if (!f.constraints.providerAllowed) return deny("provider_denied");
  if (!f.constraints.entitlementAllowed) return deny("entitlement_denied");
  return result(
    "allowed",
    revision,
    at,
    op,
    {
      requester: m.owner,
      authorizer: m.owner,
      dispatchers: [],
      executor: a.current.actor,
      envelopeId: null,
      mandateId: m.id,
    },
    false,
  );
}
// Reads current facts once on EVERY call. These are fixture-capable server ports,
// not authenticator adapters. No model/client payload is a source of authority.
export function createAgentAuthorityService(
  reader: AgentAuthorityReader,
  clock: () => Date = () => new Date(),
) {
  return Object.freeze({
    async decideDelegation(value: unknown): Promise<AgentPermissionResult> {
      let input: DelegationEligibilityInput;
      try {
        const v = parseJsonText(value);
        closed(v, ["envelopeId", "executorInstallationId", "operation"]);
        if (!valid("Id", v.envelopeId) || !valid("Id", v.executorInstallationId)) throw Error();
        parseOperation(v.operation);
        input = v as unknown as DelegationEligibilityInput;
      } catch {
        throw new AgentAuthorityError("AGENT_POLICY_INPUT_INVALID");
      }
      try {
        const facts = parseDelegation(parseJsonText(await reader.readDelegationCurrent(input)));
        const at = clock().toISOString();
        if (!time(at)) throw Error();
        return evaluateDelegation(input, facts, at);
      } catch {
        throw new AgentAuthorityError("AGENT_POLICY_AUTHORITY_UNAVAILABLE");
      }
    },
    async decideAutomation(value: unknown): Promise<AgentPermissionResult> {
      let input: AutomationEligibilityInput;
      try {
        const v = parseJsonText(value);
        closed(v, ["mandateId", "executorInstallationId", "operation"]);
        if (!valid("Id", v.mandateId) || !valid("Id", v.executorInstallationId)) throw Error();
        parseOperation(v.operation);
        input = v as unknown as AutomationEligibilityInput;
      } catch {
        throw new AgentAuthorityError("AGENT_POLICY_INPUT_INVALID");
      }
      try {
        const facts = parseAutomation(parseJsonText(await reader.readAutomationCurrent(input)));
        const at = clock().toISOString();
        if (!time(at)) throw Error();
        return evaluateAutomation(input, facts, at);
      } catch {
        throw new AgentAuthorityError("AGENT_POLICY_AUTHORITY_UNAVAILABLE");
      }
    },
  });
}
