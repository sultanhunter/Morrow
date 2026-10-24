// P01.T02c PR-A: collaboration contracts v1.1 (ADR-0016). AC01-AC07, AC09, AC11
// and AC12; AC08 is in agent-authority.test.mjs and AC10 in navigation.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  eventRowDigest,
  inspectDeclaredReplacements,
  inspectEventRegistryBaseline,
  inspectRefinedSelectorUse,
  inspectSupersededUse,
  refinedDefinitionNames,
  replacedDefinitionNames,
} from "../scripts/boundary-checks.mjs";
import {
  changesPath,
  currentDefinitionSelectors,
  eventPayloadSelectors,
  eventRegistryPath,
  eventRegistrySince,
  readEventRegistry,
  readSchemaSources,
  schemasByKind,
} from "../scripts/contract-sources.mjs";
import {
  checkFixture,
  inspectAskAdminReadRecord,
  inspectCollaborationDefaults,
  inspectEvent,
  inspectEventRegistry,
  inspectSidebar,
  inspectTransition,
  primaryDestinations,
} from "../scripts/contract-checks.mjs";
import { validateCatalogue } from "../scripts/foundation.mjs";
import { readEffectiveBodies } from "../scripts/contract-sources.mjs";
import {
  eventRegistered,
  validateCapabilityInput,
  validateCapabilityOutput,
  validateCurrentDefinition,
  validateDefinition,
  validateEventPayload,
} from "../packages/contracts/src/validation.ts";
import {
  approvalDecideFields,
  askAdminGrant,
  askAdminTemplateIds,
  askAdminTemplateViolations,
  collaborationPermissions,
  workMetadataFields,
} from "../packages/contracts/src/work-permissions.ts";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sources = readSchemaSources();
const layered = schemasByKind(sources);
const changes = json(changesPath);
const baseline = json("docs/contracts/release-baseline.json");
const catalogue = json("docs/contracts/capabilities.json");
const registry = readEventRegistry();
const defaults = json("docs/contracts/collaboration-defaults.json");
const routes = json("docs/contracts/workspace-routes.json");
const fixtures = json("docs/contracts/fixtures/P01.T02c.json").cases;
const fixture = (id) => {
  const found = fixtures.find((f) => f.id === `P01.T02c.${id}`);
  assert.ok(found, id);
  return found;
};
const core11 = layered["core-v1.1"].$defs;

// The definitions, bodies and capabilities P01.T02c adds (§2-§8).
const added = [
  "NullableId",
  "Boolean",
  "StreamPosition",
  "PageCursor",
  "NullablePageCursor",
  "PageRequest",
  "ConversationRef",
  "MessageRef",
  "ProjectRef",
  "AccessRequestRef",
  "OperationRef",
  "KillSwitchRecordRef",
  "EventPayloadRef",
  "TrustClass",
  "CitedRef",
  "GrantVerb",
  "BoundedFieldList",
  "RestrictedSource",
  "RequestReason",
  "ContextTaint",
  "ConversationSubject",
  "ConversationSelector",
  "Conversation",
  "MessageStatus",
  "HumanMentionTarget",
  "AgentMentionTarget",
  "MentionTarget",
  "NotifyMentionRequest",
  "TaskMentionRequest",
  "DelegateMentionRequest",
  "MentionRequest",
  "TextPart",
  "ArtifactPart",
  "ProposalPart",
  "QuestionPart",
  "EvidenceSummaryPart",
  "EvidenceSummaryPartInput",
  "MentionPart",
  "MessagePart",
  "MessagePartInput",
  "MessagePartInputs",
  "MessageOrigin",
  "Message",
  "PostInput",
  "MessageDelta",
  "StreamFrame",
  "AskAdminReadAsk",
  "AskAdminReadRecord",
  "InboxKind",
  "InboxSubject",
  "StopProposalStatus",
  "AccessRequestStatus",
  "DecisionState",
  "ReadState",
  "InboxContext",
  "InboxItem",
  "InboxFilter",
  "InboxItemIds",
  "InboxMarkInput",
  "InboxItems",
  "InboxPage",
  "ProjectTitle",
  "ProjectTabTitle",
  "ProjectTab",
  "ProjectTabInput",
  "ProjectTabInputs",
  "Project",
  "AccessRequestScope",
  "AccessRequestContext",
  "AccessRequest",
  "AccessRequestDecisionInput",
  "AccessRequestWithdrawInput",
  "StopProposalDismissInput",
  "EmptyEventPayload",
  "GoalCreatedPayload",
  "GoalStatusChangedPayload",
  "TaskCreatedPayload",
  "TaskStatusChangedPayload",
  "TaskAssignedPayload",
  "QuestionRequestedPayload",
  "QuestionAnsweredPayload",
  "ConversationCreatedPayload",
  "MessageCreatedPayload",
  "MessageStatusChangedPayload",
  "ProjectCreatedPayload",
  "ProjectPinChangedPayload",
  "AccessRequestStatusChangedPayload",
  "ProposalCreatedPayload",
  "ApprovalCreatedPayload",
  "ApprovalStatusChangedPayload",
  "OperationStatusChangedPayload",
  "KillSwitchExecutedPayload",
  "EventPayload",
  "EventEnvelope",
];
const newCapabilities = [
  "workspace.conversation.create",
  "workspace.conversation.post",
  "workspace.project.create",
  "workspace.project.revise",
  "workspace.project.pin",
  "workspace.inbox.read",
  "workspace.inbox.mark",
  "governance.access.request",
];
const newBodies = newCapabilities.flatMap((id) => [`${id}.input`, `${id}.output`]);
const v1Envelope = json("docs/contracts/fixtures/P01.A02.json").find(
  (f) => f.id === "P01.A02.schema.valid.EventEnvelope",
).value;

test("AC01: v1 stays frozen; EventEnvelope is the one declared replacement", () => {
  for (const source of sources.filter((s) => s.path.includes("/v1/")))
    assert.equal(
      createHash("sha256").update(source.text).digest("hex"),
      baseline.schemas[source.path],
      source.path,
    );
  for (const source of sources.filter((s) => s.path.includes("/v1.1/")))
    assert.equal(
      createHash("sha256").update(source.text).digest("hex"),
      baseline.schemas[source.path],
      source.path,
    );
  for (const name of added) assert.ok(Object.hasOwn(core11, name), name);
  // Every addition is a new name except the declared EventEnvelope replacement.
  const reused = added.filter((name) => Object.hasOwn(layered.core.$defs, name));
  assert.deepEqual(reused, ["EventEnvelope"]);
  for (const body of newBodies) {
    assert.ok(Object.hasOwn(layered["capabilities-v1.1"].$defs, body), body);
    assert.ok(!Object.hasOwn(layered.capabilities.$defs, body), body);
  }
  const declaration = changes.changes.find((c) => c.name === "EventEnvelope");
  assert.deepEqual(
    [declaration.kind, declaration.replaces, declaration.adr],
    ["definition", "core:EventEnvelope", "ADR-0016"],
  );
  assert.deepEqual(inspectDeclaredReplacements(changes, layered), []);
  assert.deepEqual(
    inspectDeclaredReplacements(
      { ...changes, changes: changes.changes.filter((c) => c.name !== "EventEnvelope") },
      layered,
    ),
    ["UNDECLARED_REPLACEMENT:EventEnvelope"],
  );
  const replaced = replacedDefinitionNames(changes);
  assert.ok(replaced.includes("EventEnvelope"));
  for (const code of [
    'validateDefinition("core", "EventEnvelope", value);',
    'import type { Core_EventEnvelope } from "@morrow/contracts";',
    'const v = validators["core:EventEnvelope"];',
  ])
    assert.deepEqual(inspectSupersededUse("packages/work/src/x.ts", code, replaced), [
      "SUPERSEDED_CONTRACT_USE:packages/work/src/x.ts:EventEnvelope",
    ]);
  for (const code of [
    'validateCurrentDefinition("EventEnvelope", value);',
    'import type { Current_EventEnvelope, CoreV1_1_EventEnvelope } from "@morrow/contracts";',
  ])
    assert.deepEqual(inspectSupersededUse("packages/work/src/x.ts", code, replaced), [], code);
  // The v1 envelope stays valid under its exact selector only.
  assert.equal(validateDefinition("core", "EventEnvelope", v1Envelope), true);
  assert.equal(validateCurrentDefinition("EventEnvelope", v1Envelope), false);
  assert.equal(validateDefinition("core-v1.1", "EventEnvelope", v1Envelope), false);
  assert.equal(currentDefinitionSelectors(layered).EventEnvelope, "core-v1.1:EventEnvelope");
  // Every P01.A02 and P01.T02a case still passes.
  for (const f of [
    ...json("docs/contracts/fixtures/P01.A02.json"),
    ...json("docs/contracts/fixtures/P01.T02a.json"),
  ])
    assert.equal(checkFixture(f), true, f.id);
});

test("AC02: every new definition, body and registry row has a valid and an invalid case; reference and generated validators agree", () => {
  const schemaCases = fixtures.filter((f) => f.kind === "schema");
  const covered = (selector) =>
    [true, false].every((valid) =>
      schemaCases.some((f) => f.selector === selector && f.valid === valid),
    );
  for (const name of added) assert.ok(covered(`core-v1.1:${name}`), name);
  for (const body of newBodies) assert.ok(covered(`capabilities-v1.1:${body}`), body);
  for (const row of registry.events) {
    assert.ok(covered(`core-v1.1:${row.payloadDefinition}`), row.eventType);
    assert.ok(
      fixtures.some((f) => f.kind === "event" && f.valid && f.value.eventType === row.eventType),
      row.eventType,
    );
  }
  assert.ok(fixtures.some((f) => f.kind === "event" && !f.valid));
  for (const f of fixtures) {
    assert.equal(checkFixture(f), true, f.id);
    if (f.kind === "event")
      assert.equal(validateCurrentDefinition("EventEnvelope", f.value), f.valid, f.id);
    if (f.kind === "current")
      assert.equal(validateCurrentDefinition(f.definition, f.value), f.valid, f.id);
    if (f.kind !== "schema") continue;
    const name = f.selector.slice(f.selector.indexOf(":") + 1);
    if (f.selector.startsWith("core-v1.1:"))
      assert.equal(validateDefinition("core-v1.1", name, f.value), f.valid, f.id);
    // Effective capability bodies through the generated validators.
    else if (name.endsWith(".input"))
      assert.equal(validateCapabilityInput(name.slice(0, -6), f.value), f.valid, f.id);
    else assert.equal(validateCapabilityOutput(name.slice(0, -7), f.value), f.valid, f.id);
  }
});

test("AC03: message parts, origin and authors", () => {
  for (const id of [
    "part.text",
    "part.artifact",
    "part.proposal",
    "part.question",
    "part.evidence",
    "part.mention_notify",
    "part.mention_task",
    "part.mention_delegate",
    "message.human",
    "message.agent_streaming",
    "message.agent_completed",
  ])
    assert.equal(fixture(id).valid, true, id);
  for (const id of [
    "part.unknown_kind",
    "part.text_extra",
    "part.text_empty",
    "part.text_long",
    "part.text_nul",
    "parts.33",
    "parts.11_mentions",
    "part.evidence_no_refs",
    "part.evidence_51_refs",
    "part.evidence_input_trust",
    "part.input_trust_class",
    "post.trust_class",
    "part.mention_agent_notify",
    "part.mention_human_delegate",
    "message.completed_no_parts",
    "message.service_author",
    "message.agent_mention",
    "message.agent_null_origin",
    "message.agent_no_installation",
    "message.agent_membership",
    "message.human_origin",
    "message.human_streaming",
    "source.no_fields",
  ])
    assert.equal(fixture(id).valid, false, id);
  for (const id of ["post.restricted_sources", "post.context_taint", "body.post_sources"])
    assert.equal(fixture(id).valid, false, id);
});

test("AC04: subjects, selectors and conversations", () => {
  for (const id of ["subject.project", "subject.task", "subject.ask", "conversation.ask"])
    assert.equal(fixture(id).valid, true, id);
  for (const id of [
    "subject.ask_no_owner",
    "subject.project_owner",
    "subject.task_owner",
    "selector.both",
    "conversation.status",
    "conversation.revised",
  ])
    assert.equal(fixture(id).valid, false, id);
});

test("AC05: the eight inbox kinds with their subjects and machines; read state is not decision state", () => {
  const kinds = new Set(
    fixtures
      .filter((f) => f.selector === "core-v1.1:InboxItem" && f.valid)
      .map((f) => f.value.kind),
  );
  assert.deepEqual([...kinds].sort(), [...core11.InboxKind.enum].sort());
  assert.equal(fixture("inbox.approval_read_pending").valid, true);
  assert.deepEqual(
    [
      fixture("inbox.approval_read_pending").value.decisionState,
      fixture("inbox.approval_read_pending").value.readState,
    ],
    [{ machine: "approval", status: "pending" }, "read"],
  );
  for (const id of [
    "inbox.question_approval_machine",
    "inbox.stop_notice_proposal",
    "inbox.quorum_without_approval",
    "filter.duplicate_kinds",
    "mark.empty",
    "mark.101",
    "inbox.failed_open",
  ])
    assert.equal(fixture(id).valid, false, id);
  // The projectId filter matches only the viewer-relative context (no hidden-project oracle).
  assert.match(core11.InboxFilter.description, /viewer-relative/);
  assert.match(core11.InboxFilter.properties.projectId.description, /viewer-relative/);
});

test("AC06: the additive event registry", () => {
  assert.equal(registry.events.length, 23);
  assert.deepEqual(inspectEventRegistry(registry), []);
  const rows = eventPayloadSelectors(layered, registry);
  for (const row of registry.events) {
    assert.equal(row.aggregateType, row.eventType.split(".")[0]);
    assert.equal(rows[row.eventType].selector, `core-v1.1:${row.payloadDefinition}`);
    assert.equal(eventRegistered(row.eventType, row.aggregateType), true);
  }
  // The eight P06.T01a payloads are exactly migration 0015's allowlist.
  const sql = readFileSync("migrations/0015.work-state.sql", "utf8");
  const types = /event_type IN \(([^)]*)\)/
    .exec(sql)[1]
    .match(/'([a-z_.]+)'/g)
    .map((t) => t.slice(1, -1));
  const p06 = registry.events.filter((r) => r.producer === "P06.T01a");
  assert.deepEqual(p06.map((r) => r.eventType).sort(), types.sort());
  const allowlist = {
    "goal.created": ["status"],
    "goal.status_changed": ["from", "to"],
    "task.status_changed": ["from", "to"],
    "task.created": ["goalId", "status"],
    "task.assigned": ["assignmentId", "ownerPrincipalId"],
    "question.requested": ["respondentPrincipalId"],
    "question.answered": ["answerId"],
    "question.cancelled": [],
  };
  for (const row of p06) {
    const definition = core11[row.payloadDefinition];
    assert.deepEqual(
      Object.keys(definition.properties).sort(),
      allowlist[row.eventType],
      row.eventType,
    );
    assert.deepEqual([...definition.required].sort(), allowlist[row.eventType], row.eventType);
    assert.match(sql, new RegExp(`'${row.eventType.replace(".", "\\.")}'`));
  }
  // The registry selector, generated and reference.
  const created = { conversationId: "conversation_c", status: "completed", authorKind: "human" };
  assert.equal(validateEventPayload("message.created", "message", created), true);
  assert.equal(validateEventPayload("message.created", "conversation", created), false);
  assert.equal(
    validateEventPayload("message.created", "message", { ...created, text: "Hi" }),
    false,
  );
  assert.equal(validateEventPayload("message.created", "message", { status: "draft" }), false);
  assert.equal(validateEventPayload("message.created", "message", null), false);
  for (const name of ["constructor", "__proto__", "toString", "message", ""])
    assert.equal(validateEventPayload(name, "message", created), false, name);
  assert.equal(validateEventPayload(42, "message", created), false);
  for (const id of [
    "event.unregistered",
    "event.aggregate_mismatch",
    "event.payload_text",
    "event.other_type_payload",
    "event.null_payload_with_ref",
    "event.ref_without_payload",
    "event.artifact_ref",
    "event.ref_other_organization",
    "event.ref_other_workspace",
    "event.ref_other_store",
    "event.ref_other_event",
  ]) {
    assert.equal(fixture(id).valid, false, id);
    assert.equal(inspectEvent(fixture(id).value), false, id);
    assert.equal(validateCurrentDefinition("EventEnvelope", fixture(id).value), false, id);
  }
  // The payloadRef binding is a code rule: the exact selector cannot express it, which
  // is why product code never validates an envelope by that selector (verify:boundaries).
  for (const id of ["event.ref_other_organization", "event.ref_other_event"])
    assert.equal(validateDefinition("core-v1.1", "EventEnvelope", fixture(id).value), true, id);
  // A nulled payload nulls its ref; the envelope then needs only a registered type.
  assert.equal(validateCurrentDefinition("EventEnvelope", fixture("event.redacted").value), true);
  // A stream frame carries only a registered envelope.
  const frame = { kind: "event", envelope: fixture("event.message.created").value };
  assert.equal(validateCurrentDefinition("StreamFrame", frame), true);
  assert.equal(
    validateCurrentDefinition("StreamFrame", {
      kind: "event",
      envelope: fixture("event.unregistered").value,
    }),
    false,
  );
  assert.equal(
    validateDefinition("core-v1.1", "StreamFrame", {
      kind: "event",
      envelope: fixture("event.unregistered").value,
    }),
    true,
  );
  // Planted registry negatives.
  const mutate = (change) => {
    const copy = structuredClone(registry);
    change(copy);
    return inspectEventRegistry(copy);
  };
  assert.match(
    mutate((r) => (r.events[9].aggregateType = "conversation")).join(),
    /EVENT_REGISTRY_INVALID/,
  );
  assert.match(mutate((r) => r.events.push({ ...r.events[0] })).join(), /EVENT_REGISTRY_INVALID/);
  assert.match(
    mutate((r) => (r.events[0].payloadDefinition = "Message")).join(),
    /EVENT_REGISTRY_INVALID/,
  );
  assert.match(mutate((r) => (r.events[0].extra = true)).join(), /EVENT_REGISTRY_INVALID/);
  assert.match(
    mutate((r) =>
      r.events.splice(
        r.events.findIndex((e) => e.eventType === "kill_switch.executed"),
        1,
      ),
    ).join(),
    /EVENT_PAYLOAD_UNREGISTERED:KillSwitchExecutedPayload/,
  );
  const texted = structuredClone(layered);
  texted["core-v1.1"].$defs.MessageCreatedPayload.properties.text = {
    type: "string",
    maxLength: 16384,
  };
  assert.deepEqual(inspectEventRegistry(registry, texted), [
    "EVENT_PAYLOAD_NOT_IDS_AND_STATUSES:MessageCreatedPayload.text",
  ]);
  const large = structuredClone(layered);
  for (const key of ["a", "b", "c", "d"])
    large["core-v1.1"].$defs.ProjectCreatedPayload.properties[key] = {
      $ref: "urn:morrow:contracts:core:v1#/$defs/Id",
    };
  assert.deepEqual(inspectEventRegistry(registry, large), [
    "EVENT_PAYLOAD_TOO_LARGE:ProjectCreatedPayload",
  ]);
  // `since` is a known contract minor from 1.1 through the current version.
  assert.deepEqual(eventRegistrySince, ["1.1"]);
  for (const since of ["1", "1.2", "2.0"])
    assert.match(
      mutate((r) => (r.events[0].since = since)).join(),
      /EVENT_REGISTRY_INVALID/,
      since,
    );
});

test("AC06: registry rows are pinned in the release baseline and append-only", () => {
  assert.equal(baseline.event_registry.path, eventRegistryPath);
  assert.deepEqual(
    Object.keys(baseline.event_registry.rows),
    registry.events.map((r) => r.eventType),
  );
  assert.deepEqual(inspectEventRegistryBaseline(baseline, registry), []);
  for (const row of registry.events)
    assert.equal(baseline.event_registry.rows[row.eventType], eventRowDigest(row), row.eventType);
  const delta = (change) => {
    const copy = structuredClone(registry);
    change(copy.events);
    return inspectEventRegistryBaseline(baseline, copy);
  };
  const message = registry.events.findIndex((r) => r.eventType === "message.created");
  assert.deepEqual(
    delta((rows) => (rows[message].aggregateType = "conversation")),
    ["UNREVIEWED_EVENT_ROW_DELTA:message.created"],
  );
  assert.deepEqual(
    delta((rows) => (rows[message].payloadDefinition = "MessageStatusChangedPayload")),
    ["UNREVIEWED_EVENT_ROW_DELTA:message.created"],
  );
  assert.deepEqual(delta((rows) => rows.splice(message, 1)).slice(0, 1), [
    "UNREVIEWED_EVENT_ROW_DELTA:message.created",
  ]);
  assert.deepEqual(
    delta((rows) => rows.push({ ...rows[0], eventType: "goal.archived" })),
    ["UNBASELINED_EVENT_ROW:goal.archived"],
  );
  assert.deepEqual(
    inspectEventRegistryBaseline({ ...baseline, event_registry: undefined }, registry),
    ["UNBASELINED_EVENT_REGISTRY"],
  );
  // A row appended and pinned passes.
  const appended = structuredClone(registry);
  appended.events.push({ ...registry.events[0], eventType: "goal.archived" });
  const pinned = structuredClone(baseline);
  pinned.event_registry.rows["goal.archived"] = eventRowDigest(appended.events.at(-1));
  assert.deepEqual(inspectEventRegistryBaseline(pinned, appended), []);
});

test("refined v1.1 definitions are validated only through validateCurrentDefinition", () => {
  // The boundary list equals the names validation.ts refines beyond their schemas.
  const source = readFileSync("packages/contracts/src/validation.ts", "utf8");
  const body = source.slice(source.indexOf("export function validateCurrentDefinition"));
  const refined = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/name === "([A-Za-z]+)"/g)]
    .map((m) => m[1])
    .sort();
  assert.deepEqual(refined, [...refinedDefinitionNames]);
  for (const name of refinedDefinitionNames) {
    for (const code of [
      `validateDefinition("core-v1.1", "${name}", value);`,
      `const v = validators["core-v1.1:${name}"];`,
    ])
      assert.deepEqual(inspectRefinedSelectorUse("packages/work/src/x.ts", code), [
        `REFINED_DEFINITION_BYPASS:packages/work/src/x.ts:${name}`,
      ]);
    assert.deepEqual(
      inspectRefinedSelectorUse(
        "packages/work/src/x.ts",
        `validateCurrentDefinition("${name}", value); type T = CoreV1_1_${name};`,
      ),
      [],
    );
    // Tests and generated files may use the exact selector.
    assert.deepEqual(
      inspectRefinedSelectorUse(
        "tests/x.test.mjs",
        `validateDefinition("core-v1.1", "${name}", v);`,
      ),
      [],
    );
  }
  assert.deepEqual(
    inspectRefinedSelectorUse(
      "packages/contracts/src/generated/runtime-validators.mjs",
      'export const s = "core-v1.1:EventEnvelope";',
    ),
    [],
  );
});

test("AskAdminReadRecord: never the reader's own Ask, each Ask once (ADR-0016 item 5)", () => {
  const cases = fixtures.filter((f) => f.kind === "current");
  assert.ok(cases.some((f) => f.valid) && cases.some((f) => !f.valid));
  for (const f of cases) {
    assert.equal(f.definition, "AskAdminReadRecord", f.id);
    assert.equal(inspectAskAdminReadRecord(f.value), f.valid, f.id);
    assert.equal(validateCurrentDefinition("AskAdminReadRecord", f.value), f.valid, f.id);
  }
  // The schema alone admits a second owner for one conversation and the reader's own Ask.
  for (const id of [
    "admin_read.current.same_conversation_two_owners",
    "admin_read.current.own_ask_listed",
    "admin_read.current.own_conversation",
  ])
    assert.equal(
      validateDefinition("core-v1.1", "AskAdminReadRecord", fixture(id).value),
      true,
      id,
    );
  // An exact duplicate is schema-invalid (uniqueItems).
  assert.equal(fixture("admin_read.duplicate_ask").valid, false);
  assert.equal(core11.AskAdminReadRecord.anyOf[0].properties.asks.uniqueItems, true);
});

test("AC07: eight catalogue entries with every field; six human_only; no control; dropped IDs absent", () => {
  const byId = new Map(catalogue.capabilities.map((c) => [c.id, c]));
  const template = byId.get("workspace.goal.create");
  for (const id of newCapabilities) {
    const c = byId.get(id);
    assert.ok(c, id);
    for (const key of Object.keys(template)) assert.ok(Object.hasOwn(c, key), `${id} ${key}`);
    assert.deepEqual(
      [
        c.provider_dependency,
        c.hosts,
        c.retention_class,
        c.activation,
        c.eligible_principal,
        c.kill_switch,
        c.review_required,
        c.irreversible,
      ],
      [
        "D01",
        ["standalone"],
        "R02",
        "blocked_until_contract_and_provider_qualified",
        "human_or_bounded_installation_with_explicit_capability_grant",
        false,
        false,
        false,
      ],
      id,
    );
    for (const key of ["resource_scope", "source_authority", "failure_behavior", "layout"])
      assert.equal(c[key], template[key], `${id} ${key}`);
    assert.ok(c.field_scope.length && c.verification && c.journey, id);
    assert.notEqual(c.effect, "control", id);
  }
  const human = newCapabilities.filter((id) => byId.get(id).executor === "human_only");
  assert.deepEqual(human.sort(), [
    "governance.access.request",
    "workspace.conversation.create",
    "workspace.inbox.mark",
    "workspace.inbox.read",
    "workspace.project.create",
    "workspace.project.pin",
  ]);
  assert.deepEqual(
    newCapabilities.filter((id) => byId.get(id).executor === "agent_direct_write").sort(),
    ["workspace.conversation.post", "workspace.project.revise"],
  );
  assert.equal(byId.get("workspace.inbox.read").effect, "read");
  for (const id of [
    "workspace.work.read",
    "governance.access.read",
    "governance.access.deny",
    "governance.access.withdraw",
    "governance.stop_proposal.dismiss",
  ])
    assert.ok(!byId.has(id), id);
  const errors = validateCatalogue(
    catalogue,
    json("docs/decisions/dependencies.json"),
    json("docs/progress/tasks.json"),
    json("docs/contracts/schema-types.json"),
    readEffectiveBodies(catalogue.capabilities.map((c) => c.id)),
  );
  assert.deepEqual(errors, []);
});

test("AC09: the collaboration permission rows pass the work-permissions contract check", () => {
  const byId = new Map(catalogue.capabilities.map((c) => [c.id, c]));
  const reasons =
    /^(subject_key|viewer_identity|viewer_relative_position|reviewer_rule|derived_from:.+)$/;
  const verbsOf = (r) => (typeof r.verb === "string" ? [r.verb] : [r.verb.own, r.verb.other]);
  for (const [key, rule] of Object.entries(collaborationPermissions)) {
    assert.ok(rule.requires.length > 0, key);
    for (const requirement of rule.requires) {
      if (requirement.kind === "kill_switch_execute") {
        assert.equal(key, "stopProposal.dismiss");
        continue;
      }
      const c = byId.get(requirement.capabilityId);
      assert.ok(c, `${key} ${requirement.capabilityId}`);
      assert.ok(!c.eligible_principal.startsWith("operator_"), key);
      assert.ok(requirement.fields.length > 0, key);
      assert.equal(new Set(requirement.fields).size, requirement.fields.length, key);
      for (const field of requirement.fields)
        assert.ok(validateDefinition("core", "FieldPath", field), `${key} ${field}`);
    }
    for (const other of rule.composes)
      assert.ok(Object.hasOwn(collaborationPermissions, other), key);
    // A subject rule names existing rows for each subject kind.
    if (rule.subject) {
      assert.deepEqual(Object.keys(rule.subject).sort(), ["ask", "project", "task"], key);
      for (const rows of Object.values(rule.subject)) {
        assert.ok(rows.length > 0, key);
        for (const other of rows) assert.ok(Object.hasOwn(collaborationPermissions, other), key);
      }
    }
    // Referenced inputs are fields the row's write requests.
    for (const field of rule.references)
      assert.ok(rule.requires[0].fields.includes(field), `${key} ${field}`);
    if (rule.reads) {
      // Each read requests every non-metadata field its definition returns, or names why it need not.
      const definition = core11[rule.reads.definition];
      const fields = rule.requires.flatMap((r) => r.fields ?? []);
      for (const property of Object.keys(definition.properties)) {
        if (workMetadataFields.includes(property)) continue;
        const requested = fields.includes(rule.reads.prefix + property);
        const ungated = rule.reads.ungated[property];
        assert.ok(requested !== (ungated !== undefined), `${key} ${property}`);
        if (ungated) {
          assert.match(ungated, reasons, `${key} ${property}`);
          // Only the reviewer rule of a decider shows a record without requested fields.
          if (ungated === "reviewer_rule") assert.equal(rule.holder, "decider", key);
          if (ungated.startsWith("derived_from:"))
            assert.ok(fields.includes(ungated.slice(13)), key);
        }
      }
      for (const property of Object.keys(rule.reads.ungated))
        assert.ok(Object.hasOwn(definition.properties, property), key);
    }
    // Agents reach a row only through capabilities they may hold (AC08).
    if (rule.agents !== "never")
      for (const r of rule.requires) {
        const c = byId.get(r.capabilityId);
        assert.notEqual(c.executor, "human_only", key);
        assert.ok(!c.eligible_principal.startsWith("eligible_human_"), key);
      }
  }
  // The agent-reachable reads (AC08): project, both subject views, messages and posts.
  assert.deepEqual(
    Object.entries(collaborationPermissions)
      .filter(([, r]) => r.agents === "kernel")
      .map(([k]) => k)
      .sort(),
    [
      "message.post",
      "message.read",
      "project.read",
      "project.revise",
      "project.subjectView",
      "task.subjectView",
    ],
  );
  assert.equal(collaborationPermissions["ask.read"].agents, "ask_envelope");
  // Rows compose without cycles, through `composes` and subject rules alike.
  const next = (k) => [
    ...collaborationPermissions[k].composes,
    ...Object.values(collaborationPermissions[k].subject ?? {}).flat(),
  ];
  const acyclic = (k, path = []) => {
    assert.ok(!path.includes(k), [...path, k].join(" -> "));
    for (const other of next(k)) acyclic(other, [...path, k]);
  };
  for (const key of Object.keys(collaborationPermissions)) acyclic(key);
  // Message reads and posts need the subject view (§3 part (a)) and every source.
  const subjectViews = { project: ["project.subjectView"], task: ["task.subjectView"] };
  const messageRows = Object.entries(collaborationPermissions).filter(
    ([, r]) => r.requires[0].capabilityId === "workspace.conversation.post",
  );
  assert.deepEqual(messageRows.map(([k]) => k).sort(), [
    "ask.read",
    "message.post",
    "message.read",
  ]);
  for (const key of ["message.read", "message.post"]) {
    const rule = collaborationPermissions[key];
    assert.deepEqual(
      [rule.subject.project, rule.subject.task],
      [subjectViews.project, subjectViews.task],
      key,
    );
    assert.equal(rule.everySource, true, key);
  }
  // An Ask's subject is its owner (agents: the owner's Ask envelope); an admin only reads.
  assert.deepEqual(collaborationPermissions["message.read"].subject.ask, [
    "ask.read",
    "ask.adminRead",
  ]);
  assert.deepEqual(collaborationPermissions["message.post"].subject.ask, ["ask.read"]);
  for (const [key, rule] of Object.entries(collaborationPermissions))
    if (key !== "message.read" && key !== "message.post") assert.equal(rule.subject, null, key);
  // Inputs that name ids pass the §3 reference rule: tab artifacts, the pin anchor, cited
  // parts and reply, the Ask store, and the access request's scope and context.
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(collaborationPermissions)
        .filter(([, r]) => r.references.length)
        .map(([k, r]) => [k, [...r.references]]),
    ),
    {
      "ask.create": ["storeId"],
      "message.post": ["parts", "replyToMessageId"],
      "project.create": ["tabs"],
      "project.revise": ["tabs"],
      "project.pin": ["beforeProjectId"],
      "accessRequest.create": ["scope", "context"],
    },
  );
  // The Ask admin row (ADR-0016 item 5): administer on conversation.create over W, audited, read-only, never agents.
  const admin = collaborationPermissions["ask.adminRead"];
  assert.deepEqual(
    [
      admin.requires[0].capabilityId,
      admin.requires[0].verb,
      admin.requires[0].fields,
      admin.requires[0].resource,
      admin.audited,
      admin.agents,
      admin.holder,
      admin.composes,
    ],
    [
      "workspace.conversation.create",
      "administer",
      ["storeId", "subject"],
      "workspace",
      true,
      "never",
      "ask_admin",
      [],
    ],
  );
  assert.deepEqual(
    Object.entries(collaborationPermissions)
      .filter(([, r]) => r.audited)
      .map(([k]) => k),
    ["ask.adminRead"],
  );
  // Only the admin row uses administer on conversation.create, by a fixed or an ownership verb.
  for (const [key, rule] of Object.entries(collaborationPermissions))
    for (const r of rule.requires)
      if (r.capabilityId === askAdminGrant.capabilityId && verbsOf(r).includes("administer"))
        assert.equal(key, "ask.adminRead");
  // Deciders are reviewers of the would-be grant revision; withdraw and mark stay with their holder.
  const decider = collaborationPermissions["accessRequest.decide"];
  assert.deepEqual(
    decider.requires.map((r) => [r.capabilityId, r.verb, r.resource]),
    [
      ["governance.approval.decide", "approve", "workspace"],
      ["governance.grants.revise", "approve", "requested_scope"],
    ],
  );
  // The decider requests every approval.decide input field, as reviewerEligible
  // (`decideFields` in packages/policy/src/review.ts) does: a partial grant never decides.
  const decideFields = Object.keys(byId.get("governance.approval.decide").input.fields);
  assert.deepEqual([...decider.requires[0].fields], decideFields);
  assert.deepEqual([...approvalDecideFields], decideFields);
  assert.match(
    readFileSync("packages/policy/src/review.ts", "utf8"),
    /const decideFields = Object\.freeze\(\s*Object\.keys\(capabilities\.get\("governance\.approval\.decide"\)\?\.input\.fields/,
  );
  // The decider's read returns the same AccessRequest fields as the requester's read.
  assert.equal(decider.reads.definition, "AccessRequest");
  assert.deepEqual(Object.keys(decider.reads.ungated), [
    ...collaborationPermissions["accessRequest.read"].requires[0].fields,
  ]);
  assert.equal(collaborationPermissions["accessRequest.withdraw"].holder, "requester");
  assert.equal(collaborationPermissions["inbox.mark"].holder, "recipient");
  assert.ok(Object.isFrozen(collaborationPermissions));
  assert.ok(Object.isFrozen(collaborationPermissions["project.read"].requires[0].fields));
  // The binding template check (ADR-0016 item 5) is default-deny: only the owner v2
  // and workspace-admin-v2 templates may carry the grant.
  assert.deepEqual([...askAdminTemplateIds], ["owner-bootstrap-v2", "workspace-admin-v2"]);
  const carries = { capabilityId: "workspace.conversation.create", verbs: ["view", "administer"] };
  assert.deepEqual(
    askAdminTemplateViolations([
      { id: "owner-bootstrap-v2", grants: [carries] },
      { id: "workspace-admin-v2", grants: [carries] },
      { id: "workspace-member-v2", grants: [{ ...carries, verbs: ["execute"] }] },
      { id: "workspace-member-v3", grants: [carries] },
      { id: "workspace-members-v2", grants: [carries] },
      { id: "workspace-admin-v1", grants: [carries] },
      { id: "owner-bootstrap-v1", grants: [carries] },
      { id: "seo-specialist-v1", grants: [carries] },
      { id: "owner-v2", grants: [carries] },
      { id: "viewer-v1", grants: [{ ...carries, verbs: ["view"] }] },
    ]),
    [
      "workspace-member-v3",
      "workspace-members-v2",
      "workspace-admin-v1",
      "owner-bootstrap-v1",
      "seo-specialist-v1",
      "owner-v2",
    ],
  );
});

test("AC11: message and access_request transitions are v1.1 only; no stop_proposal machine", () => {
  const transitions = json("docs/contracts/state-transitions.json");
  assert.ok(!Object.hasOwn(transitions.transitions, "stop_proposal"));
  for (const machine of ["message", "access_request"])
    for (const row of transitions.transitions[machine]) assert.equal(row.since, "1.1", machine);
  const at = (id, version) => inspectTransition({ ...fixture(id), version });
  assert.equal(at("state.message_completed", "1.1"), true);
  assert.equal(at("state.message_completed", "1"), false);
  assert.equal(at("state.message_reopened", "1.1"), false);
  assert.equal(at("state.access_granted", "1.1"), true);
  assert.equal(at("state.access_granted", "1"), false);
  assert.equal(at("state.access_granted_by_decider", "1.1"), false);
  for (const f of fixtures.filter((f) => f.kind === "transition"))
    assert.equal(checkFixture(f), true, f.id);
});

test("AC12: no collaboration shape reaches a grant; AccessRequestScope only from its input and record", () => {
  const byId = Object.fromEntries(sources.map((s) => [s.schema.$id, s.schema]));
  const reach = (schema, base, seen = new Set()) => {
    const found = new Set();
    const visit = (node, at) => {
      if (Array.isArray(node)) return node.forEach((n) => visit(n, at));
      if (!node || typeof node !== "object") return;
      if (typeof node.$ref === "string") {
        const [id, name] = node.$ref.startsWith("#")
          ? [at, node.$ref.slice(8)]
          : node.$ref.split("#/$defs/");
        const key = `${id}#${name}`;
        found.add(name);
        if (!seen.has(key)) {
          seen.add(key);
          visit(byId[id].$defs[name], id);
        }
      }
      for (const [k, v] of Object.entries(node)) if (k !== "$ref") visit(v, at);
    };
    visit(schema, base);
    return found;
  };
  const core11Id = layered["core-v1.1"].$id,
    caps11Id = layered["capabilities-v1.1"].$id;
  const roots = [
    ...added.map((name) => [name, core11[name], core11Id]),
    ...newBodies.map((name) => [name, layered["capabilities-v1.1"].$defs[name], caps11Id]),
  ];
  for (const [name, schema, base] of roots) {
    const names = reach(schema, base);
    assert.ok(!names.has("Grant") && !names.has("GrantRef"), name);
  }
  for (const id of newCapabilities) {
    const output = layered["capabilities-v1.1"].$defs[`${id}.output`];
    assert.ok(
      Object.keys(output.properties).every((p) => !/grant|membership|policyRevision/i.test(p)),
      id,
    );
  }
  // AccessRequestScope is reachable only from the request input and the AccessRequest record.
  const reaching = [];
  for (const source of sources)
    for (const [name, schema] of Object.entries(source.schema.$defs))
      if (
        name !== "AccessRequestScope" &&
        reach(schema, source.schema.$id).has("AccessRequestScope")
      )
        reaching.push(name);
  assert.deepEqual(reaching.sort(), ["AccessRequest", "governance.access.request.input"]);
});

test("collaboration defaults agree with the schemas", () => {
  assert.deepEqual(inspectCollaborationDefaults(defaults), []);
  assert.deepEqual(defaults.trustRank[0], "untrusted_external");
  assert.deepEqual(defaults.trustRank.at(-1), "provider_fact");
  assert.deepEqual(defaults.openStates.operation, ["uncertain", "conflict"]);
  const drift = (change) => {
    const copy = structuredClone(defaults);
    change(copy);
    return inspectCollaborationDefaults(copy);
  };
  assert.deepEqual(
    drift((d) => d.trustRank.pop()),
    ["TRUST_RANK_INVALID"],
  );
  assert.deepEqual(
    drift((d) => d.openStates.approval.push("granted")),
    ["OPEN_STATES_INVALID:approval"],
  );
  assert.deepEqual(
    drift((d) => d.openStates.none.push("informational")),
    ["OPEN_STATES_INVALID:none"],
  );
  assert.deepEqual(
    drift((d) => (d.limits.pageSize.maximum = 100)),
    ["LIMIT_DRIFT:pageSize"],
  );
  assert.deepEqual(
    drift((d) => (d.limits.mentionPartsPerMessage = 11)),
    ["LIMIT_DRIFT:mentionPartsPerMessage"],
  );
  assert.deepEqual(
    drift((d) => (d.kindMachines.mention = ["task"])),
    ["KIND_MACHINES_INVALID"],
  );
  assert.deepEqual(
    drift((d) => (d.kindMachines.mention = ["comment"])),
    ["KIND_MACHINES_INVALID"],
  );
  assert.deepEqual(
    drift((d) => (d.extra = 1)),
    ["COLLABORATION_DEFAULTS_INVALID"],
  );
});

test("the sidebar model is reconciled with the routes", () => {
  assert.deepEqual(inspectSidebar(routes), []);
  assert.deepEqual(
    routes.sidebar.primary.map((p) => p.id),
    primaryDestinations,
  );
  const broken = (change) => {
    const copy = structuredClone(routes);
    change(copy.sidebar);
    return inspectSidebar(copy);
  };
  assert.deepEqual(
    broken((s) => s.primary.unshift({ id: "ask", route: "ask" })),
    ["SIDEBAR_PRIMARY", "SIDEBAR_ASK_IS_ACTION"],
  );
  assert.deepEqual(
    broken((s) => (s.pinned_projects.maximum = 21)),
    ["SIDEBAR_PINNED_PROJECTS"],
  );
  assert.deepEqual(
    broken((s) => (s.footer[1].params.section = "invoices")),
    ["SIDEBAR_TARGET:credit_balance"],
  );
  assert.deepEqual(
    broken((s) => (s.people_and_agents[0].route = "people")),
    ["SIDEBAR_TARGET:people"],
  );
  assert.deepEqual(
    broken((s) => s.primary.reverse()),
    ["SIDEBAR_PRIMARY"],
  );
  assert.deepEqual(
    broken((s) => (s.entry_action = "home")),
    ["SIDEBAR_ENTRY_ACTION"],
  );
});
