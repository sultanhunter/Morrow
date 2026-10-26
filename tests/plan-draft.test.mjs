// PR 18 (ADR-0034 items 1-4, 7, 8 and 10): plan.draft grants nothing and is refused in a
// turn holding a report; the Coordinator's launch subset has no task.create; Morrow's
// tools in an Ask; choice questions; @Morrow's verbs; a card keeps its taint through edits;
// the switch is committed off; plan.draft is ToolCatalogue@1 version 2's, and its recorded
// input maps to PlanDraft@1. Code checks only: no model is involved.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import {
  checkToolInput,
  modelToolDefinitions,
  toolCatalogueVersion,
  toolEntry,
  toolsForContext,
} from "../packages/policy/src/tool-catalogue.ts";
import {
  askTools,
  coordinatorGrantTools,
  coordinatorLaunchTools,
  decideAskRoute,
  decideChoiceQuestion,
  decideCoordinatorMention,
  decidePlanDraft,
  mentionRunTools,
  planDraftDigest,
  planDraftFromToolInput,
  planDraftsRecord,
  planDraftsSwitchAllowed,
  planDraftTool,
  planDraftValid,
  reviseDraft,
  turnTools,
} from "../packages/policy/src/projects/index.ts";

const checklist = {
  kind: "checklist",
  checklistId: "product_facts_complete",
  productIds: ["product:1"],
  target: 12,
  dueAt: "2026-11-13T00:00:00Z",
  startRef: null,
};
const project = {
  schemaVersion: 1,
  kind: "project",
  title: "Everyday Tote in AI answers",
  why: "AI assistants should be able to name the tote.",
  doneWhen: "The page has all 12 facts.",
  goals: [{ key: "facts", description: "Page complete", measure: checklist }],
  steps: [
    {
      key: "channel",
      title: "Check the AI channel",
      assignee: { kind: "person", principalId: "principal_maya" },
      dependsOn: [],
      repeat: null,
    },
    {
      key: "checkup",
      title: "AI answers check-up",
      assignee: { kind: "specialist", purpose: "Find missing facts" },
      dependsOn: ["channel"],
      repeat: null,
    },
    {
      key: "update",
      title: "Update the page",
      assignee: { kind: "agent", installationId: "installation_listings" },
      dependsOn: ["checkup"],
      repeat: null,
    },
  ],
  target: { kind: "new_project", dueAt: "2026-12-04T00:00:00Z" },
};
const task = {
  ...project,
  kind: "task",
  title: "Fix size chart",
  goals: [],
  steps: [{ ...project.steps[0], key: "fix", title: "Fix the size chart" }],
  target: { kind: "area", areaTemplateId: "product_pages" },
};
const change = {
  ...project,
  kind: "plan_change",
  title: "Add a review step",
  goals: [],
  steps: [project.steps[0]],
  target: { kind: "existing_project", projectId: "project_a", goalRevision: 3 },
};
// A PlanDraft@1 as the model writes it in a plan.draft call (ToolInputPlanDraft): every
// choice flattened, the other fields null or empty, keys as goalKey and stepKey.
const asToolInput = (d) => ({
  kind: d.kind,
  title: d.title,
  why: d.why,
  doneWhen: d.doneWhen,
  goals: d.goals.map((g) => ({
    goalKey: g.key,
    description: g.description,
    measure: {
      kind: g.measure.kind,
      metricId: g.measure.metricId ?? null,
      checklistId: g.measure.checklistId ?? null,
      productIds: g.measure.kind === "checklist" ? g.measure.productIds : [],
      assistant: g.measure.assistant ?? null,
      cadenceWeeks: g.measure.cadenceWeeks ?? null,
      rows: g.measure.kind === "manual" ? g.measure.rows : [],
      target: g.measure.target,
      dueAt: g.measure.dueAt,
    },
  })),
  steps: d.steps.map((s) => ({
    stepKey: s.key,
    title: s.title,
    assignee: {
      kind: s.assignee.kind,
      principalId: s.assignee.principalId ?? null,
      installationId: s.assignee.installationId ?? null,
      purpose: s.assignee.purpose ?? null,
    },
    dependsOn: s.dependsOn,
    repeat: s.repeat,
  })),
  target: {
    kind: d.target.kind,
    dueAt: d.target.dueAt ?? null,
    projectId: d.target.projectId ?? null,
    goalRevision: d.target.goalRevision ?? null,
    areaTemplateId: d.target.areaTemplateId ?? null,
  },
});
const turn = (extra = {}) => ({
  conversation: "project",
  mentionRun: false,
  holdsReport: false,
  askEnvelope: false,
  agentRoutesUsed: 0,
  choiceQuestionsAsked: 0,
  switchState: "on",
  ...extra,
});

test("the switch is committed off with the start routes held", () => {
  const record = JSON.parse(readFileSync("docs/decisions/plan-drafts-staging.json", "utf8"));
  assert.equal(record.switch, "off");
  assert.equal(record.start_routes, "held");
  assert.deepEqual(planDraftsRecord, { switch: "off", start_routes: "held" });
  // On only after the agent loop and P05.T04b's Ask-bound envelope.
  assert.equal(
    planDraftsSwitchAllowed({ planDrafts: "off", agentLoop: "off", askEnvelope: false }),
    true,
  );
  assert.equal(
    planDraftsSwitchAllowed({ planDrafts: "on", agentLoop: "off", askEnvelope: true }),
    false,
  );
  assert.equal(
    planDraftsSwitchAllowed({ planDrafts: "on", agentLoop: "on", askEnvelope: false }),
    false,
  );
  assert.equal(
    planDraftsSwitchAllowed({ planDrafts: "on", agentLoop: "on", askEnvelope: true }),
    true,
  );
});

test("plan.draft is ToolCatalogue@1's: grants nothing, on workspace.conversation.post, 8 KiB results", () => {
  assert.equal(planDraftTool, toolEntry("plan.draft"));
  const { description, inputSchema, ...entry } = planDraftTool;
  assert.deepEqual(entry, {
    name: "plan.draft",
    wireName: "plan_draft",
    family: "coordination",
    capabilityId: "workspace.conversation.post",
    verb: "execute",
    replayClass: "internal_write",
    resultMaxBytes: 8192,
    inputDefinition: "ToolInputPlanDraft",
    contexts: ["coordinator"],
  });
  assert.match(description, /grants nothing/);
  assert.ok(Object.isFrozen(planDraftTool));
  // A catalogue entry names no grant: a tool is one capability and verb, checked per call.
  assert.equal(Object.hasOwn(planDraftTool, "grants"), false);
  // Version 2 added plan.draft; version 3 (PR 20) knowledge.propose and notebook.write;
  // version 4 (ADR-0037) the teammate tools.
  assert.equal(toolCatalogueVersion, 4, "a new tool is a new catalogue version (ADR-0037: 4)");
  const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
  const post = catalogue.capabilities.find((c) => c.id === planDraftTool.capabilityId);
  assert.equal(post.executor, "agent_direct_write");
  assert.equal(post.effect, "internal_write");
  // The model sees the strict shape under the wire name; no field names a key, store,
  // capability, grant, model, recipient or sender.
  const [def] = modelToolDefinitions(["plan.draft"]);
  assert.equal(def.name, "plan_draft");
  assert.deepEqual(def.input_schema, inputSchema);
  const names = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.properties) names.push(...Object.keys(node.properties));
    Object.values(node).forEach(walk);
  };
  walk(inputSchema);
  for (const name of ["key", "storeId", "capabilityId", "grant", "model", "startRef", "sender"])
    assert.ok(!names.includes(name), name);
});

test("a plan.draft input maps to PlanDraft@1: one draft per input, startRef always null", () => {
  for (const d of [project, task, change]) {
    const input = asToolInput(d);
    assert.ok(validateCurrentDefinition("ToolInputPlanDraft", input), d.kind);
    assert.deepEqual(checkToolInput("plan.draft", input), { ok: true }, d.kind);
    assert.ok(validateCurrentDefinition("ToolModelInputPlanDraft", input), d.kind);
    assert.deepEqual(planDraftFromToolInput(input), d, d.kind);
  }
  const manual = {
    kind: "manual",
    assistant: "chatgpt",
    cadenceWeeks: 4,
    rows: [{ productId: "product:1", checkItems: ["Best tan canvas tote bag?"] }],
    target: 2,
    dueAt: null,
    startRef: null,
  };
  const metric = {
    kind: "metric",
    metricId: "days_of_stock_cover",
    target: 14,
    dueAt: null,
    startRef: null,
  };
  const measured = {
    ...project,
    goals: [
      { key: "named", description: "Named in answers", measure: manual },
      { key: "cover", description: "Stock cover", measure: metric },
    ],
  };
  assert.deepEqual(planDraftFromToolInput(asToolInput(measured)), measured);
  const input = asToolInput(project);
  const edit = (change) => {
    const copy = structuredClone(input);
    change(copy);
    return copy;
  };
  for (const [name, bad] of [
    ["a new project with a project id", edit((i) => (i.target.projectId = "project_a"))],
    ["a new project with no date", edit((i) => (i.target.dueAt = null))],
    [
      "an area with a date",
      edit((i) => Object.assign(i.target, { kind: "area", areaTemplateId: "stock" })),
    ],
    ["a checklist with a metric", edit((i) => (i.goals[0].measure.metricId = "orders_per_week"))],
    ["a checklist with rows", edit((i) => (i.goals[0].measure.rows = manual.rows))],
    ["a metric with no metric id", edit((i) => (i.goals[0].measure.kind = "metric"))],
    ["a person step with a purpose", edit((i) => (i.steps[0].assignee.purpose = "x"))],
    [
      "a code step naming an agent",
      edit((i) =>
        Object.assign(i.steps[0].assignee, {
          kind: "code",
          principalId: null,
          installationId: "installation_a",
        }),
      ),
    ],
    ["a startRef", edit((i) => (i.goals[0].measure.startRef = null))],
    ["a key in place of goalKey", edit((i) => (i.goals[0].key = "facts"))],
    ["a store", edit((i) => (i.storeId = "store_a"))],
    ["a schemaVersion", edit((i) => (i.schemaVersion = 1))],
    ["a date-only due date", edit((i) => (i.target.dueAt = "2026-12-04"))],
    ["PlanDraft@1 itself", project],
  ])
    assert.equal(planDraftFromToolInput(bad), null, name);
  // Inside the strict shape, outside a limit: the call's invalid_input, never a mapped draft.
  const long = edit((i) => (i.title = "x".repeat(81)));
  assert.ok(validateCurrentDefinition("ToolModelInputPlanDraft", long));
  assert.deepEqual(checkToolInput("plan.draft", long), {
    ok: false,
    outcome: "invalid_input",
    refusal: "input_invalid",
  });
  assert.equal(planDraftFromToolInput(long), null);
});

test("the launch Coordinator subset leaves task.create out; the grant set keeps it", () => {
  // The grant set is ToolCatalogue@1's Coordinator tools, in catalogue order.
  assert.deepEqual([...coordinatorGrantTools], [...toolsForContext("coordinator")]);
  assert.ok(coordinatorGrantTools.includes("task.create"));
  for (const state of ["on", "off"])
    assert.ok(!coordinatorLaunchTools(state).includes("task.create"));
  assert.ok(coordinatorLaunchTools("on").includes("plan.draft"));
  assert.ok(!coordinatorLaunchTools("off").includes("plan.draft"), "absent while off");
  assert.ok(!coordinatorLaunchTools().includes("plan.draft"), "committed off");
  // ADR-0037 item 9: the teammate tools follow their own switches, both committed off.
  const team = (teammateCalls, agentCards) => ({ teammateCalls, agentCards });
  for (const tool of ["agent.ask", "agent.result.read", "agent.propose"])
    assert.ok(!coordinatorLaunchTools().includes(tool), tool + " committed off");
  assert.ok(coordinatorLaunchTools("on", team("on", "off")).includes("agent.ask"));
  assert.ok(coordinatorLaunchTools("on", team("on", "off")).includes("agent.result.read"));
  assert.ok(!coordinatorLaunchTools("on", team("on", "off")).includes("agent.propose"));
  assert.ok(coordinatorLaunchTools("on", team("off", "on")).includes("agent.propose"));
  assert.ok(!coordinatorLaunchTools("on", team("off", "on")).includes("agent.ask"));
  assert.ok(coordinatorLaunchTools("off", team("off", "off")).includes("agent.route"));
});

test("Morrow in an Ask: only under the envelope; never task.create, agent.propose, inbox.ask", () => {
  for (const tool of ["task.create", "agent.propose", "inbox.ask"])
    assert.ok(!askTools.includes(tool), tool);
  assert.deepEqual(turnTools(turn({ conversation: "ask", askEnvelope: false })), []);
  assert.deepEqual(
    turnTools(turn({ conversation: "ask", askEnvelope: true, switchState: "off" })),
    [],
  );
  assert.deepEqual(turnTools(turn({ conversation: "ask", askEnvelope: true })), [
    "knowledge.search",
    "work.read",
    "message.post",
    "plan.draft",
    "agent.route",
  ]);
  assert.ok(
    !turnTools(turn({ conversation: "ask", askEnvelope: true, agentRoutesUsed: 1 })).includes(
      "agent.route",
    ),
    "agent.route once per run",
  );
  assert.equal(
    decideAskRoute(turn({ conversation: "ask", askEnvelope: true }), { active: true, added: true }),
    "ok",
  );
  assert.equal(
    decideAskRoute(turn({ conversation: "ask", askEnvelope: true, agentRoutesUsed: 1 }), {
      active: true,
      added: true,
    }),
    "route_used",
  );
  assert.equal(
    decideAskRoute(turn({ conversation: "ask", askEnvelope: false }), {
      active: true,
      added: true,
    }),
    "ask_envelope_missing",
  );
  assert.equal(
    decideAskRoute(turn({ conversation: "ask", askEnvelope: true }), {
      active: false,
      added: true,
    }),
    "input_invalid",
  );
  // The @Morrow run: no task.create, no agent.route, no agent.propose, no inbox.ask.
  assert.deepEqual(
    [...mentionRunTools],
    ["knowledge.search", "work.read", "message.post", "plan.draft"],
  );
  assert.deepEqual(turnTools(turn({ mentionRun: true })), [...mentionRunTools]);
});

test("plan.draft: refused while off, in a turn holding a report, without the Ask envelope", async () => {
  assert.deepEqual(await decidePlanDraft(turn({ switchState: "off" }), asToolInput(project)), {
    ok: false,
    refusal: "plan_drafts_off",
  });
  assert.deepEqual(await decidePlanDraft(turn({ holdsReport: true }), asToolInput(project)), {
    ok: false,
    refusal: "report_in_context",
  });
  assert.deepEqual(await decidePlanDraft(turn({ conversation: "ask" }), asToolInput(project)), {
    ok: false,
    refusal: "ask_envelope_missing",
  });
  const decided = await decidePlanDraft(turn(), asToolInput(project));
  assert.equal(decided.ok, true);
  assert.deepEqual(decided.draft, project);
  assert.equal(decided.digest, await planDraftDigest(project));
  // The model's input is the tool's, never PlanDraft@1 itself, and never one that breaks
  // PlanDraft@1's code rules.
  assert.deepEqual(await decidePlanDraft(turn(), project), {
    ok: false,
    refusal: "input_invalid",
  });
  assert.deepEqual(await decidePlanDraft(turn(), asToolInput({ ...project, title: "Tote" })), {
    ok: false,
    refusal: "input_invalid",
  });
  // A mention run drafts only a task or a plan change.
  assert.deepEqual(await decidePlanDraft(turn({ mentionRun: true }), asToolInput(project)), {
    ok: false,
    refusal: "card_kind_not_allowed",
  });
  assert.equal((await decidePlanDraft(turn({ mentionRun: true }), asToolInput(task))).ok, true);
  assert.equal((await decidePlanDraft(turn({ mentionRun: true }), asToolInput(change))).ok, true);
});

test("PlanDraft@1's code rules: titles, kinds, keys, order, start values, dates", () => {
  for (const d of [project, task, change]) assert.equal(planDraftValid(d), true, d.kind);
  const bad = {
    "one-word title": { ...project, title: "Tote" },
    "seven-word title": { ...project, title: "a b c d e f g" },
    "project without goals": { ...project, goals: [] },
    "project on an area": { ...project, target: { kind: "area", areaTemplateId: "stock" } },
    "duplicate step keys": { ...project, steps: [project.steps[0], project.steps[0]] },
    "a later dependency": {
      ...project,
      steps: [{ ...project.steps[0], dependsOn: ["checkup"] }, ...project.steps.slice(1)],
    },
    "a client start value": {
      ...project,
      goals: [{ ...project.goals[0], measure: { ...checklist, startRef: "value_0" } }],
    },
    "a goal due after the project": {
      ...project,
      goals: [{ ...project.goals[0], measure: { ...checklist, dueAt: "2026-12-05T00:00:00Z" } }],
    },
    "a repeat naming another goal": {
      ...project,
      steps: [{ ...project.steps[0], repeat: { cadence: "monthly", goalKey: "other" } }],
    },
    "a task with goals": { ...task, goals: project.goals },
    "a task with two steps": { ...task, steps: [task.steps[0], { ...task.steps[0], key: "b" }] },
    "a task for a specialist": {
      ...task,
      steps: [{ ...task.steps[0], assignee: { kind: "specialist", purpose: "x" } }],
    },
    "a repeating card without a repeat": { ...task, kind: "repeating" },
    "a plan change on a new project": { ...change, target: project.target },
    "an extra field": { ...project, capabilityId: "workspace.project.create" },
  };
  for (const [name, value] of Object.entries(bad)) assert.equal(planDraftValid(value), false, name);
  const repeating = {
    ...task,
    kind: "repeating",
    steps: [{ ...task.steps[0], repeat: { cadence: "weekly", goalKey: null } }],
    target: { kind: "area", areaTemplateId: "stock" },
  };
  assert.equal(planDraftValid(repeating), true);
});

test("choice questions: Coordinator only, at most 2 per run", () => {
  assert.equal(decideChoiceQuestion(turn(), true), "ok");
  assert.equal(decideChoiceQuestion(turn({ choiceQuestionsAsked: 1 }), true), "ok");
  assert.equal(
    decideChoiceQuestion(turn({ choiceQuestionsAsked: 2 }), true),
    "choice_budget_spent",
  );
  assert.equal(decideChoiceQuestion(turn(), false), "tool_not_in_subset");
  assert.equal(decideChoiceQuestion(turn({ switchState: "off" }), true), "plan_drafts_off");
  assert.equal(decideChoiceQuestion(turn({ conversation: "ask" }), true), "ask_envelope_missing");
});

test("@Morrow: human-authored, project conversations only, three verbs, never authority", () => {
  const ok = {
    authorKind: "human",
    conversation: "project",
    conversationCreateExecute: true,
    conversationPostExecute: true,
    projectGoalView: true,
    switchState: "on",
  };
  assert.equal(decideCoordinatorMention(ok), "ok");
  assert.equal(decideCoordinatorMention({ ...ok, authorKind: "agent" }), "AGENT_MENTION_DENIED");
  assert.equal(decideCoordinatorMention({ ...ok, conversation: "ask" }), "MENTION_NOT_ALLOWED");
  assert.equal(decideCoordinatorMention({ ...ok, conversation: "task" }), "MENTION_NOT_ALLOWED");
  // A Member lacking workspace.conversation.create (the human_only right to open an Ask).
  assert.equal(
    decideCoordinatorMention({ ...ok, conversationCreateExecute: false }),
    "PERMISSION_DENIED",
  );
  assert.equal(
    decideCoordinatorMention({ ...ok, conversationPostExecute: false }),
    "PERMISSION_DENIED",
  );
  assert.equal(decideCoordinatorMention({ ...ok, projectGoalView: false }), "PERMISSION_DENIED");
  assert.equal(decideCoordinatorMention({ ...ok, switchState: "off" }), "plan_drafts_off");
});

test("a person's edit is a new revision that keeps the original's taint and sources", async () => {
  const source = {
    capabilityId: "catalog.products.read",
    resource: {
      organizationId: "org_a",
      workspaceId: "workspace_a",
      storeId: "store_a",
      connectionId: "connection_a",
      kind: "store",
      id: "store_a",
    },
    accountId: null,
    fields: ["title"],
  };
  const original = {
    messageId: "message_a",
    revision: 1,
    draft: project,
    digest: await planDraftDigest(project),
    editorPrincipalId: null,
    contextTaint: "untrusted_external",
    restrictedSources: [source],
  };
  const edited = await reviseDraft(
    original,
    { ...project, title: "Tote in AI answers" },
    "principal_maya",
  );
  assert.equal(edited.revision, 2);
  assert.equal(edited.editorPrincipalId, "principal_maya");
  assert.notEqual(edited.digest, original.digest);
  assert.equal(edited.contextTaint, "untrusted_external", "an edit never clears a taint");
  assert.deepEqual(edited.restrictedSources, [source]);
  assert.equal(await reviseDraft(original, { ...project, title: "x" }, "principal_maya"), null);
  assert.equal(await reviseDraft(original, task, "principal_maya"), null, "an edit keeps the kind");
});
