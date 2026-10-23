// PR 18 (ADR-0034 items 1-4, 7, 8 and 10): plan.draft grants nothing and is refused in a
// turn holding a report; the Coordinator's launch subset has no task.create; Morrow's
// tools in an Ask; choice questions; @Morrow's verbs; a card keeps its taint through edits;
// the switch is committed off. Code checks only: no model is involved.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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

test("plan.draft grants nothing, on workspace.conversation.post, 8 KiB results", () => {
  assert.deepEqual(planDraftTool, {
    name: "plan.draft",
    capabilityId: "workspace.conversation.post",
    verb: "execute",
    replayClass: "internal_write",
    resultBoundBytes: 8192,
    grants: [],
  });
  assert.ok(Object.isFrozen(planDraftTool) && Object.isFrozen(planDraftTool.grants));
  const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
  const post = catalogue.capabilities.find((c) => c.id === planDraftTool.capabilityId);
  assert.equal(post.executor, "agent_direct_write");
  assert.equal(post.effect, "internal_write");
});

test("the launch Coordinator subset leaves task.create out; the grant set keeps it", () => {
  assert.ok(coordinatorGrantTools.includes("task.create"));
  for (const state of ["on", "off"])
    assert.ok(!coordinatorLaunchTools(state).includes("task.create"));
  assert.ok(coordinatorLaunchTools("on").includes("plan.draft"));
  assert.ok(!coordinatorLaunchTools("off").includes("plan.draft"), "absent while off");
  assert.ok(!coordinatorLaunchTools().includes("plan.draft"), "committed off");
});

test("Morrow in an Ask: only under the envelope; never task.create, specialist.draft, inbox.ask", () => {
  for (const tool of ["task.create", "specialist.draft", "inbox.ask"])
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
  // The @Morrow run: no task.create, no agent.route, no specialist.draft, no inbox.ask.
  assert.deepEqual(
    [...mentionRunTools],
    ["knowledge.search", "work.read", "message.post", "plan.draft"],
  );
  assert.deepEqual(turnTools(turn({ mentionRun: true })), [...mentionRunTools]);
});

test("plan.draft: refused while off, in a turn holding a report, without the Ask envelope", () => {
  assert.deepEqual(decidePlanDraft(turn({ switchState: "off" }), project), {
    ok: false,
    refusal: "plan_drafts_off",
  });
  assert.deepEqual(decidePlanDraft(turn({ holdsReport: true }), project), {
    ok: false,
    refusal: "report_in_context",
  });
  assert.deepEqual(decidePlanDraft(turn({ conversation: "ask" }), project), {
    ok: false,
    refusal: "ask_envelope_missing",
  });
  const decided = decidePlanDraft(turn(), project);
  assert.equal(decided.ok, true);
  assert.equal(decided.digest, planDraftDigest(project));
  assert.notEqual(decided.draft, project, "a copy, never the caller's object");
  // A mention run drafts only a task or a plan change.
  assert.deepEqual(decidePlanDraft(turn({ mentionRun: true }), project), {
    ok: false,
    refusal: "card_kind_not_allowed",
  });
  assert.equal(decidePlanDraft(turn({ mentionRun: true }), task).ok, true);
  assert.equal(decidePlanDraft(turn({ mentionRun: true }), change).ok, true);
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

test("a person's edit is a new revision that keeps the original's taint and sources", () => {
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
    digest: planDraftDigest(project),
    editorPrincipalId: null,
    contextTaint: "untrusted_external",
    restrictedSources: [source],
  };
  const edited = reviseDraft(
    original,
    { ...project, title: "Tote in AI answers" },
    "principal_maya",
  );
  assert.equal(edited.revision, 2);
  assert.equal(edited.editorPrincipalId, "principal_maya");
  assert.notEqual(edited.digest, original.digest);
  assert.equal(edited.contextTaint, "untrusted_external", "an edit never clears a taint");
  assert.deepEqual(edited.restrictedSources, [source]);
  assert.equal(reviseDraft(original, { ...project, title: "x" }, "principal_maya"), null);
  assert.equal(reviseDraft(original, task, "principal_maya"), null, "an edit keeps the kind");
});
