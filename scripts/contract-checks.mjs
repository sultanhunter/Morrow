import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import canonicalize from "canonicalize";
import { read, sha } from "./foundation.mjs";
import {
  readSchemaSources,
  contractVersion,
  schemasByKind,
  eventPayloadSelectors,
  readEventRegistry,
} from "./contract-sources.mjs";

if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Contract checks require the pinned Node 24 runtime");
export const core = read("docs/contracts/schemas/v1/core.schema.json");
export const bodies = read("docs/contracts/schemas/v1/capabilities.schema.json");
export const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  validateFormats: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
addFormats(ajv);
ajv.addSchema(core);
ajv.addSchema(bodies);
export const validators = Object.fromEntries(
  Object.keys(core.$defs).map((name) => [
    name,
    ajv.compile({ $ref: core.$id + "#/$defs/" + name }),
  ]),
);
export const bodyValidators = Object.fromEntries(
  Object.keys(bodies.$defs).map((name) => [
    name,
    ajv.compile({ $ref: bodies.$id + "#/$defs/" + name }),
  ]),
);
// Reference (non-generated) validators for any exact selector `<kind>:<name>` of
// the contract set in scripts/contract-sources.mjs. Sources are registered and
// compiled on first use, after importers such as billing-checks.mjs have added
// the schemas they own to this shared instance.
export const sources = readSchemaSources();
const compiled = new Map();
export function selectorValidator(selector) {
  for (const s of sources) if (!ajv.getSchema(s.schema.$id)) ajv.addSchema(s.schema);
  const separator = selector.indexOf(":"),
    source = sources.find((s) => s.kind === selector.slice(0, separator)),
    name = selector.slice(separator + 1);
  if (!source || !Object.hasOwn(source.schema.$defs, name))
    throw new Error("Unknown contract selector " + selector);
  if (!compiled.has(selector))
    compiled.set(selector, ajv.compile({ $ref: source.schema.$id + "#/$defs/" + name }));
  return compiled.get(selector);
}
export const digest = (value) => sha(canonicalize(value));
export function proposalDigest(proposal) {
  const { proposalDigest, ...content } = proposal;
  return digest(content);
}

// Executable examples for contract review, not runtime authentication or policy.
export function inspectBinding(context) {
  const c = structuredClone(context);
  const h = c.hostContext,
    p = c.proposal,
    a = c.approval;
  // Fixture setup resolves three canonical digests once, before case mutation.
  const errors = [];
  for (const [name, value] of [
    ["HostContext", h],
    ["Proposal", p],
    ["Approval", a],
  ])
    if (!validators[name](value)) errors.push("SCHEMA_INVALID_" + name);
  if (errors.length) return errors;
  if (!c.trustedServerBootstrap) errors.push("UNAUTHENTICATED_HOST");
  if (!c.currentMembership) errors.push("MEMBERSHIP_REVOKED");
  if (h.organizationId !== h.principal.organizationId || h.workspaceId !== h.principal.workspaceId)
    errors.push("HOST_PRINCIPAL_MISMATCH");
  if (
    h.organizationId !== p.organizationId ||
    h.workspaceId !== p.workspaceId ||
    h.organizationId !== p.scope.organizationId ||
    h.workspaceId !== p.scope.workspaceId
  )
    errors.push("WORKSPACE_MISMATCH");
  if (p.storeId !== c.requestedTargetStoreId) errors.push("TARGET_STORE_MISMATCH");
  const sameScope = (r) =>
    r.organizationId === p.organizationId &&
    r.workspaceId === p.workspaceId &&
    r.storeId === p.storeId;
  if (p.storeId !== null && (p.scope.storeIds.length !== 1 || p.scope.storeIds[0] !== p.storeId))
    errors.push("PROPOSAL_STORE_SCOPE_MISMATCH");
  if (!sameScope(p.parametersRef) || !sameScope(p.reviewPolicyRef))
    errors.push("PAYLOAD_REFERENCE_SCOPE_MISMATCH");
  if (p.parametersRef.digest !== p.parametersDigest)
    errors.push("PARAMETERS_REFERENCE_DIGEST_MISMATCH");
  if (
    p.targets.some(
      (t) =>
        !sameScope(t.resource) ||
        !p.scope.resources.some((r) => digest(r) === digest(t.resource)) ||
        t.fields.some((field) => !p.scope.fields.includes(field)),
    )
  )
    errors.push("TARGET_SCOPE_MISMATCH");
  if (
    a.reviewer &&
    (a.reviewer.organizationId !== p.organizationId || a.reviewer.workspaceId !== p.workspaceId)
  )
    errors.push("REVIEWER_SCOPE_MISMATCH");
  if (!h.authorizedStoreIds.includes(p.storeId)) errors.push("STORE_DENIED");
  if (Date.parse(h.sessionExpiresAt) <= Date.parse(c.now)) errors.push("SESSION_EXPIRED");
  if (h.policyRevision !== c.currentPolicyRevision || a.policyRevision !== c.currentPolicyRevision)
    errors.push("POLICY_CHANGED");
  if (p.proposalDigest !== proposalDigest(p)) errors.push("PROPOSAL_DIGEST_MISMATCH");
  if (p.parametersDigest !== digest(c.parameters)) errors.push("PARAMETERS_DIGEST_MISMATCH");
  if (a.proposalRef.id !== p.id || a.proposalRef.revision !== p.revision)
    errors.push("PROPOSAL_REFERENCE_MISMATCH");
  if (
    a.proposalRef.organizationId !== p.organizationId ||
    a.proposalRef.workspaceId !== p.workspaceId ||
    a.proposalRef.storeId !== p.storeId ||
    a.organizationId !== p.organizationId ||
    a.workspaceId !== p.workspaceId ||
    a.storeId !== p.storeId
  )
    errors.push("APPROVAL_REFERENCE_SCOPE_MISMATCH");
  if (a.proposalDigest !== p.proposalDigest || a.proposalRef.digest !== p.proposalDigest)
    errors.push("APPROVAL_DIGEST_MISMATCH");
  if (a.scopeDigest !== digest(p.scope)) errors.push("APPROVAL_SCOPE_MISMATCH");
  if (
    a.status !== "approved" ||
    a.decision !== "approve" ||
    Date.parse(a.expiresAt) <= Date.parse(c.now) ||
    Date.parse(p.expiresAt) <= Date.parse(c.now)
  )
    errors.push("APPROVAL_NOT_CURRENT");
  if (!c.reviewerEligible || a.reviewer?.kind !== "human") errors.push("REVIEWER_DENIED");
  return errors;
}
// Contract versions that transition rows name in `since` and `superseded_in` (P01.T02a §8).
export const transitionVersions = Object.freeze(["1", "1.1"]);
export const currentTransitionVersion = contractVersion.replace(/^morrow\.contracts\.v/, "");
if (!transitionVersions.includes(currentTransitionVersion))
  throw new Error("Unknown current transition version");
const versionOrder = (v) => {
  const i = transitionVersions.indexOf(v);
  if (i < 0) throw new Error("Unknown transition version " + v);
  return i;
};
// The rows in force at `version`: a row added later (`since`) or already superseded (`superseded_in`) is ignored.
export function transitionRowsAt(table, aggregate, version = currentTransitionVersion) {
  const at = versionOrder(version);
  return (table.transitions[aggregate] ?? []).filter(
    (t) =>
      (t.since === undefined || versionOrder(t.since) <= at) &&
      (t.superseded_in === undefined || versionOrder(t.superseded_in) > at),
  );
}
export function inspectTransition(fixture, version = fixture.version ?? currentTransitionVersion) {
  const table = read("docs/contracts/state-transitions.json");
  return (
    fixture.guardPassed &&
    transitionRowsAt(table, fixture.aggregate, version).some(
      (t) =>
        t.from === fixture.from &&
        t.to === fixture.to &&
        t.actor === fixture.actor &&
        t.guard === fixture.guard &&
        (t.capability === undefined || t.capability === fixture.capability),
    )
  );
}
export function inspectHandoff(v) {
  return (
    !v.consumed &&
    Date.parse(v.expiresAt) > Date.parse(v.now) &&
    v.boundPrincipalId === v.requestingPrincipalId &&
    v.boundWorkspaceId === v.requestedWorkspaceId &&
    v.boundInstallationId === v.requestedInstallationId &&
    v.expectedOwnershipRevision === v.currentOwnershipRevision &&
    !v.ownershipConflict &&
    v.currentGrant
  );
}
// --- P01.T02c (ADR-0016): event registry, collaboration defaults and sidebar ---
export const layered = schemasByKind(sources);
const defOf = (selector) => {
  const i = selector.indexOf(":");
  return layered[selector.slice(0, i)]?.$defs?.[selector.slice(i + 1)];
};
let registryCache = null;
const registry = () => (registryCache ??= eventPayloadSelectors(layered, readEventRegistry()));
// EventEnvelope@2 by the reference compiler: the schema plus the registry row of
// its eventType (aggregate type and payload definition); a nulled payload is allowed.
export function inspectEvent(envelope, rows = registry()) {
  if (!selectorValidator("core-v1.1:EventEnvelope")(envelope)) return false;
  const row = Object.hasOwn(rows, envelope.eventType) ? rows[envelope.eventType] : null;
  return (
    row !== null &&
    row.aggregateType === envelope.aggregateType &&
    (envelope.payload === null || selectorValidator(row.selector)(envelope.payload))
  );
}
const idRef = "urn:morrow:contracts:core:v1#/$defs/Id";
// The largest JSON value a payload property schema admits (IDs, statuses, booleans and null only), or null when it admits anything else.
function largest(schema) {
  if (schema?.$ref === idRef || schema?.$ref === "urn:morrow:contracts:core:v1#/$defs/CapabilityId")
    return "x".repeat(128);
  if (typeof schema?.$ref === "string") {
    const [base, name] = schema.$ref.split("#/$defs/"),
      target = (base ? Object.values(layered).find((s) => s.$id === base) : layered["core-v1.1"])
        ?.$defs?.[name];
    return /Status$/.test(name) && Array.isArray(target?.enum)
      ? [...target.enum].sort((a, b) => b.length - a.length)[0]
      : null;
  }
  if (schema?.type === "boolean") return false;
  if (schema?.type === "string" && Array.isArray(schema.enum))
    return [...schema.enum].sort((a, b) => b.length - a.length)[0];
  if (Array.isArray(schema?.anyOf) && schema.anyOf.length === 2 && schema.anyOf[1].type === "null")
    return largest(schema.anyOf[0]);
  return null;
}
// Registry rows are well formed; every EventPayload member is registered and every row's payload is a member; payloads carry IDs and statuses only, at most 512 JCS bytes.
export function inspectEventRegistry(file, byKind = layered) {
  let rows;
  try {
    rows = eventPayloadSelectors(byKind, file);
  } catch (error) {
    return [error.message];
  }
  const errors = [],
    union = (byKind["core-v1.1"].$defs.EventPayload?.anyOf ?? []).map((r) =>
      r.$ref.replace("#/$defs/", ""),
    );
  const used = new Set(file.events.map((r) => r.payloadDefinition));
  for (const name of union) if (!used.has(name)) errors.push("EVENT_PAYLOAD_UNREGISTERED:" + name);
  for (const name of used) {
    if (!union.includes(name)) errors.push("EVENT_PAYLOAD_NOT_IN_UNION:" + name);
    const schema = byKind["core-v1.1"].$defs[name];
    if (!schema || schema.type !== "object" || schema.additionalProperties !== false) {
      errors.push("EVENT_PAYLOAD_NOT_CLOSED:" + name);
      continue;
    }
    const maximal = {};
    for (const [key, property] of Object.entries(schema.properties)) {
      const value = largest(property);
      if (value === null) errors.push(`EVENT_PAYLOAD_NOT_IDS_AND_STATUSES:${name}.${key}`);
      else maximal[key] = value;
    }
    if (Buffer.byteLength(canonicalize(maximal)) > 512)
      errors.push("EVENT_PAYLOAD_TOO_LARGE:" + name);
  }
  if (Object.keys(rows).length !== file.events.length) errors.push("EVENT_REGISTRY_INVALID:count");
  return errors;
}
const enumOf = (s) =>
  s?.enum ??
  (s?.$ref
    ? enumOf(
        defOf(
          s.$ref.startsWith("#")
            ? "core-v1.1:" + s.$ref.slice(8)
            : "core:" + s.$ref.split("#/$defs/")[1],
        ),
      )
    : s && "const" in s
      ? [s.const]
      : undefined);
// docs/contracts/collaboration-defaults.json agrees with the v1.1 schemas: the trust rank orders every TrustClass, every inbox kind maps to DecisionState machines, open states belong to their machine, and each published limit equals the schema bound.
export function inspectCollaborationDefaults(d, byKind = layered) {
  const errors = [],
    defs = byKind["core-v1.1"].$defs,
    same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (
    !d ||
    typeof d !== "object" ||
    !same(Object.keys(d).sort(), [
      "adr",
      "kindMachines",
      "limits",
      "neverOpen",
      "openStates",
      "schema_version",
      "trustRank",
    ]) ||
    d.schema_version !== 1 ||
    !same(d.adr, ["ADR-0016"])
  )
    return ["COLLABORATION_DEFAULTS_INVALID"];
  if (
    d.trustRank.length !== defs.TrustClass.enum.length ||
    !same([...d.trustRank].sort(), [...defs.TrustClass.enum].sort())
  )
    errors.push("TRUST_RANK_INVALID");
  const machines = Object.fromEntries(
    defs.DecisionState.anyOf.map((o) => [o.properties.machine.const, enumOf(o.properties.status)]),
  );
  if (!same(Object.keys(d.kindMachines), defs.InboxKind.enum)) errors.push("KIND_MACHINES_INVALID");
  for (const list of Object.values(d.kindMachines))
    if (!Array.isArray(list) || !list.length || list.some((m) => !Object.hasOwn(machines, m)))
      errors.push("KIND_MACHINES_INVALID");
  // The InboxItem conditions fix each kind's machine; an exception's machine follows its reason.
  const fixed = {};
  for (const c of defs.InboxItem.allOf ?? []) {
    const machine = c.then?.properties?.decisionState?.properties?.machine?.const,
      kind = c.if?.properties?.kind?.const;
    if (machine === undefined) continue;
    const key = kind ?? (c.if?.properties?.subject?.properties?.reason ? "exception" : undefined);
    if (key) (fixed[key] ??= []).push(machine);
  }
  if (
    !same(
      Object.keys(d.kindMachines).map((k) => [k, [...(d.kindMachines[k] ?? [])].sort()]),
      Object.keys(d.kindMachines).map((k) => [k, [...(fixed[k] ?? [])].sort()]),
    )
  )
    errors.push("KIND_MACHINES_INVALID");
  if (!same(Object.keys(d.openStates).sort(), Object.keys(machines).sort()))
    errors.push("OPEN_STATES_INVALID");
  for (const [machine, states] of Object.entries(d.openStates))
    if (
      !Array.isArray(states) ||
      new Set(states).size !== states.length ||
      states.some((s) => !machines[machine]?.includes(s)) ||
      (machine === "none" && states.length)
    )
      errors.push("OPEN_STATES_INVALID:" + machine);
  if (!same(d.neverOpen, ["failed_operation"])) errors.push("NEVER_OPEN_INVALID");
  const l = d.limits,
    p = defs.Message.properties,
    a = defs.AccessRequestScope.properties;
  for (const [name, actual, expected] of [
    [
      "messageParts",
      [l.messageParts?.minimum, l.messageParts?.maximum],
      [defs.MessagePartInputs.minItems, defs.MessagePartInputs.maxItems],
    ],
    [
      "mentionPartsPerMessage",
      [l.mentionPartsPerMessage, l.mentionPartsPerMessage],
      [defs.MessagePartInputs.maxContains, p.parts.maxContains],
    ],
    ["textPartCharacters", l.textPartCharacters, defs.TextPart.properties.text.maxLength],
    [
      "evidenceSummaryCharacters",
      l.evidenceSummaryCharacters,
      defs.EvidenceSummaryPart.properties.text.maxLength,
    ],
    [
      "evidenceRefsPerSummary",
      l.evidenceRefsPerSummary,
      defs.EvidenceSummaryPart.properties.evidenceRefs.maxItems,
    ],
    ["restrictedSourcesPerMessage", l.restrictedSourcesPerMessage, p.restrictedSources.maxItems],
    ["fieldsPerSource", l.fieldsPerSource, defs.BoundedFieldList.maxItems],
    ["viewRequirementsPerMessage", l.viewRequirementsPerMessage, p.restrictedSources.maxItems + 2],
    [
      "pageSize",
      [l.pageSize?.minimum, l.pageSize?.maximum],
      [defs.PageRequest.properties.limit.minimum, defs.PageRequest.properties.limit.maximum],
    ],
    [
      "inboxMarkBatch",
      [l.inboxMarkBatch?.minimum, l.inboxMarkBatch?.maximum],
      [defs.InboxItemIds.minItems, defs.InboxItemIds.maxItems],
    ],
    ["projectTitleCharacters", l.projectTitleCharacters, defs.ProjectTitle.maxLength],
    [
      "projectTabs",
      [l.projectTabs, l.projectTabs],
      [defs.ProjectTabInputs.maxItems, defs.Project.properties.tabs.maxItems],
    ],
    ["projectTabTitleCharacters", l.projectTabTitleCharacters, defs.ProjectTabTitle.maxLength],
    [
      "pinnedProjectsPerWorkspace",
      l.pinnedProjectsPerWorkspace,
      defs.Project.properties.pinRank.anyOf[0].maximum + 1,
    ],
    ["accessRequest.resources", l.accessRequest?.resources, a.resources.maxItems],
    ["accessRequest.stores", l.accessRequest?.stores, a.storeIds.maxItems],
    ["accessRequest.accounts", l.accessRequest?.accounts, a.accountIds.maxItems],
    [
      "accessRequest.fields",
      [l.accessRequest?.fields?.minimum, l.accessRequest?.fields?.maximum],
      [defs.BoundedFieldList.minItems, defs.BoundedFieldList.maxItems],
    ],
    [
      "accessRequest.reasonCharacters",
      l.accessRequest?.reasonCharacters,
      defs.RequestReason.maxLength,
    ],
    [
      "askAdminReadRecordAsks",
      l.askAdminReadRecordAsks,
      defs.AskAdminReadRecord.anyOf[0].properties.asks.maxItems,
    ],
  ])
    if (!same(actual, expected)) errors.push("LIMIT_DRIFT:" + name);
  return [...new Set(errors)];
}
// The option-1 sidebar (P01.T02c §11): Ask is an action; the seven primary destinations in order; every target is an existing route with valid parameters; pinned projects target `project`, at most 20.
export const primaryDestinations = Object.freeze([
  "home",
  "work",
  "inbox",
  "agents",
  "assets",
  "knowledge",
  "settings",
]);
export function inspectSidebar(routes) {
  const errors = [],
    s = routes?.sidebar,
    byId = new Map((routes?.routes ?? []).map((r) => [r.id, r]));
  if (!s || typeof s !== "object") return ["SIDEBAR_MISSING"];
  if (
    JSON.stringify(Object.keys(s).sort()) !==
    JSON.stringify([
      "description",
      "entry_action",
      "footer",
      "people_and_agents",
      "pinned_projects",
      "primary",
    ])
  )
    errors.push("SIDEBAR_KEYS");
  if (s.entry_action !== "ask" || !byId.has("ask")) errors.push("SIDEBAR_ENTRY_ACTION");
  const params = (t) => {
    const r = byId.get(t.route);
    if (!r) return false;
    const names = [...r.pattern.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)]
      .map((m) => m[1])
      .filter((n) => n !== "workspaceId");
    const given = t.params ?? {};
    return (
      JSON.stringify(Object.keys(given).sort()) ===
        JSON.stringify(names.filter((n) => n in given).sort()) &&
      Object.entries(given).every(
        ([k, v]) => names.includes(k) && (r.parameter_enums?.[k]?.includes(v) ?? false),
      )
    );
  };
  const targets = [...(s.primary ?? []), ...(s.people_and_agents ?? []), ...(s.footer ?? [])];
  for (const t of targets)
    if (!byId.has(t.route) || (t.params !== undefined && !params(t)))
      errors.push("SIDEBAR_TARGET:" + t.id);
  if (
    JSON.stringify((s.primary ?? []).map((t) => t.id)) !== JSON.stringify(primaryDestinations) ||
    (s.primary ?? []).some((t) => t.route !== t.id || t.params !== undefined)
  )
    errors.push("SIDEBAR_PRIMARY");
  if ((s.primary ?? []).some((t) => t.id === "ask" || t.route === "ask"))
    errors.push("SIDEBAR_ASK_IS_ACTION");
  if (
    (s.primary ?? []).find((t) => t.id === "inbox")?.badge !== "open_inbox_items" ||
    (s.primary ?? []).some((t) => t.id !== "inbox" && t.badge !== undefined)
  )
    errors.push("SIDEBAR_BADGE");
  const p = s.pinned_projects;
  if (
    !p ||
    p.route !== "project" ||
    p.maximum !== 20 ||
    p.order !== "viewer_relative_pin_rank" ||
    p.breadcrumb_parent !== "work" ||
    byId.get("project")?.parent !== "work"
  )
    errors.push("SIDEBAR_PINNED_PROJECTS");
  return errors;
}
export function checkFixture(f) {
  if (f.kind === "schema")
    return (
      (f.selector ? selectorValidator(f.selector) : validators[f.definition])(f.value) === f.valid
    );
  if (f.kind === "event") return inspectEvent(f.value) === f.valid;
  if (f.kind === "binding")
    return (
      JSON.stringify(inspectBinding(f.context).sort()) ===
      JSON.stringify([...f.expectedErrors].sort())
    );
  if (f.kind === "transition") return inspectTransition(f) === f.allowed;
  if (f.kind === "handoff") return inspectHandoff(f.value) === f.allowed;
  if (f.kind === "fence")
    return (
      (f.value.expectedRevision === f.value.currentRevision &&
        f.value.requestedGeneration === f.value.currentGeneration) === f.allowed
    );
  throw new Error("Unknown fixture kind " + f.kind);
}
