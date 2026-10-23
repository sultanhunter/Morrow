// PR 18 (ADR-0033 and ADR-0034; docs/briefs/projects-backend.md): the flow contracts.
// Every new v1.1 definition has a valid and an invalid case here; the message part,
// author, origin and mention edits keep P01.T02c's verdicts (collaboration-contracts).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateCapabilityInput,
  validateCapabilityOutput,
  validateCurrentDefinition,
  validateDefinition,
} from "../packages/contracts/src/validation.ts";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const core11 = json("docs/contracts/schemas/v1.1/core.schema.json").$defs;
const catalogue = json("docs/contracts/capabilities.json");
const ok = (name, value) => validateCurrentDefinition(name, value);
const at = "2026-10-24T10:30:00Z";
const digest = "a".repeat(64);
const human = {
  kind: "human",
  principalId: "principal_maya",
  organizationId: "org_a",
  workspaceId: "workspace_a",
  membershipId: "membership_maya",
  installationId: null,
  mandateId: null,
};
const checklist = {
  kind: "checklist",
  checklistId: "product_facts_complete",
  productIds: ["product:1"],
  target: 12,
  dueAt: "2026-11-13T00:00:00Z",
  startRef: null,
};
const manual = {
  kind: "manual",
  assistant: "chatgpt",
  cadenceWeeks: 4,
  rows: [{ productId: "product:1", checkItems: ["Best tan canvas tote bag for everyday use?"] }],
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

test("every new definition is in core v1.1 and none reuses a v1 name but Goal and CriteriaList", () => {
  const added = [
    "AreaTemplateId",
    "GoalKey",
    "NullableGoalKey",
    "GoalMetricId",
    "GoalChecklistId",
    "GoalAssistant",
    "GoalTarget",
    "GoalCheckItem",
    "GoalCheckRow",
    "GoalMeasure",
    "GoalCriteria",
    "GoalObjective",
    "NullableUtcTime",
    "ReadTag",
    "ReadTags",
    "GoalCheckAnswer",
    "GoalCheckAnswers",
    "GoalValueClass",
    "GoalMeasureValue",
    "GoalHealth",
    "GoalHealthReason",
    "GoalValueSource",
    "GoalMeasureProgress",
    "GoalProgress",
    "AreaRepeatingTask",
    "EverydayAreaTemplate",
    "PlanTarget",
    "PlanStepAssignee",
    "PlanStepDraft",
    "PlanGoalDraft",
    "PlanDraft",
    "PlanStartRecords",
    "PlanStartDocument",
    "PlanStepRun",
    "PlanStartResult",
    "CheckupNextStepCode",
    "PlanCardPart",
    "PlanChangeCardPart",
    "ChoiceQuestionPart",
    "ProjectUpdatePart",
    "CheckupDonePart",
    "SystemAuthor",
    "CoordinatorMentionTarget",
    "AskMentionRequest",
  ];
  const v1 = json("docs/contracts/schemas/v1/core.schema.json").$defs;
  for (const name of added) {
    assert.ok(Object.hasOwn(core11, name), name);
    assert.ok(!Object.hasOwn(v1, name), name);
  }
});

test("GoalMeasure: three closed kinds; startRef is a server field", () => {
  for (const m of [checklist, manual, metric]) assert.equal(ok("GoalMeasure", m), true, m.kind);
  for (const [name, bad] of [
    ["unknown kind", { ...metric, kind: "model_judged" }],
    ["unknown metric", { ...metric, metricId: "revenue_lift" }],
    ["negative target", { ...metric, target: -1 }],
    [
      "no startRef key",
      Object.fromEntries(Object.entries(metric).filter(([k]) => k !== "startRef")),
    ],
    [
      "21 products",
      { ...checklist, productIds: Array.from({ length: 21 }, (_, i) => `product:${i + 1}`) },
    ],
    ["cadence 14", { ...manual, cadenceWeeks: 14 }],
    ["no rows", { ...manual, rows: [] }],
    [
      "11 questions",
      { ...manual, rows: [{ productId: "product:1", checkItems: Array(11).fill("q") }] },
    ],
    ["unknown assistant", { ...manual, assistant: "claude" }],
    ["a grant", { ...metric, grant: "orders.read" }],
    ["a store", { ...metric, storeId: "store_a" }],
  ])
    assert.equal(ok("GoalMeasure", bad), false, name);
});

test("GoalMeasureValue@1: classes, clocks and the hand-check recorder", () => {
  const code = {
    schemaVersion: 1,
    id: "value_1",
    organizationId: "org_a",
    workspaceId: "workspace_a",
    goalId: "goal_a",
    key: "cover",
    productId: null,
    value: 9,
    observedAt: at,
    recorder: { kind: "code" },
    assistant: null,
    answers: [],
    counted: true,
    readTags: [{ storeId: "store_a", capabilityId: "orders.read" }],
    dataClass: "order_aggregates",
    expiresAt: "2027-01-22T10:30:00Z",
  };
  const hand = {
    ...code,
    key: "named",
    productId: "product:1",
    value: 1,
    recorder: human,
    assistant: "chatgpt",
    answers: ["named_this_product", "named_no_shop"],
    readTags: [{ storeId: "store_a", capabilityId: "catalog.products.read" }],
    dataClass: "work",
    expiresAt: null,
  };
  assert.equal(ok("GoalMeasureValue", code), true);
  assert.equal(ok("GoalMeasureValue", hand), true);
  for (const [name, bad] of [
    ["order value without a clock", { ...code, expiresAt: null }],
    ["work value with a clock", { ...hand, expiresAt: "2027-01-22T10:30:00Z" }],
    ["hand check without an assistant", { ...hand, assistant: null }],
    ["hand check without answers", { ...hand, answers: [] }],
    ["hand check without a product", { ...hand, productId: null }],
    ["code with answers", { ...code, answers: ["named_no_shop"] }],
    ["code with an assistant", { ...code, assistant: "gemini" }],
    ["an agent recorder", { ...code, recorder: { ...human, kind: "agent" } }],
    [
      "an unknown tag",
      { ...code, readTags: [{ storeId: "store_a", capabilityId: "ads.performance.read" }] },
    ],
    ["an unknown answer", { ...hand, answers: ["named_maybe"] }],
  ])
    assert.equal(ok("GoalMeasureValue", bad), false, name);
});

test("GoalProgress@1 and EverydayAreaTemplate@1", () => {
  const progress = {
    schemaVersion: 1,
    goalId: "goal_a",
    goalRevision: 2,
    health: "behind",
    reason: "off_target_side",
    since: at,
    goals: [
      {
        key: "facts",
        health: "behind",
        reason: "off_target_side",
        since: at,
        value: { value: 5, source: "checklist", observedAt: at },
        target: 12,
        direction: "at_least",
        dueAt: "2026-11-13T00:00:00Z",
      },
    ],
    computedAt: at,
  };
  assert.equal(ok("GoalProgress", progress), true);
  assert.equal(ok("GoalProgress", { ...progress, health: "fine" }), false);
  assert.equal(ok("GoalProgress", { ...progress, goals: Array(4).fill(progress.goals[0]) }), false);
  assert.equal(ok("GoalProgress", { ...progress, hiddenGoals: 1 }), false, "no hidden count");
  const template = {
    schemaVersion: 1,
    id: "product_pages",
    releaseId: "morrow.listings",
    label: "Product pages",
    objective: "Every product has a complete listing",
    goal: {
      key: "pages_complete",
      description: "Every product has a complete listing",
      measure: { ...checklist, productIds: [], target: 100, dueAt: null },
      direction: "at_least",
      onTrackThreshold: 90,
    },
    repeatingTasks: [
      { key: "size_chart", title: "Size chart check", cadence: "weekly", defaultOn: false },
    ],
  };
  assert.equal(ok("EverydayAreaTemplate", template), true);
  assert.equal(
    ok("EverydayAreaTemplate", {
      ...template,
      repeatingTasks: [{ ...template.repeatingTasks[0], defaultOn: true }],
    }),
    false,
    "a template never turns a repeating task on",
  );
  assert.equal(ok("EverydayAreaTemplate", { ...template, releaseId: "acme.listings" }), false);
});

test("PlanDraft@1: closed model fields only", () => {
  const draft = {
    schemaVersion: 1,
    kind: "project",
    title: "Everyday Tote in AI answers",
    why: "AI assistants should be able to name the tote.",
    doneWhen: "The page has all 12 facts and assistants name it in 2 of 5 questions.",
    goals: [
      { key: "facts", description: "Everyday Tote's page is complete", measure: checklist },
      { key: "named", description: "AI assistants name the Everyday Tote", measure: manual },
    ],
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
        assignee: { kind: "specialist", purpose: "Find the facts the page is missing" },
        dependsOn: ["channel"],
        repeat: null,
      },
      {
        key: "monthly",
        title: "Check AI answers",
        assignee: { kind: "person", principalId: "principal_maya" },
        dependsOn: [],
        repeat: { cadence: "monthly", goalKey: "named" },
      },
    ],
    target: { kind: "new_project", dueAt: "2026-12-04T00:00:00Z" },
  };
  assert.equal(ok("PlanDraft", draft), true);
  for (const [name, bad] of [
    ["a capability", { ...draft, capabilityId: "workspace.project.create" }],
    ["a model", { ...draft, model: "claude_opus_5_5" }],
    ["a scope", { ...draft, scope: {} }],
    ["9 steps", { ...draft, steps: Array(9).fill(draft.steps[0]) }],
    ["4 goals", { ...draft, goals: Array(4).fill(draft.goals[0]) }],
    ["no steps", { ...draft, steps: [] }],
    [
      "a specialist with a spec",
      {
        ...draft,
        steps: [
          { ...draft.steps[1], assignee: { kind: "specialist", purpose: "x", skills: ["a"] } },
        ],
      },
    ],
    [
      "a recipient",
      { ...draft, steps: [{ ...draft.steps[0], assignee: { kind: "email", to: "a@b.c" } }] },
    ],
    ["a store target", { ...draft, target: { kind: "store", storeId: "store_a" } }],
    ["values", { ...draft, values: [{ key: "facts", value: 5 }] }],
  ])
    assert.equal(ok("PlanDraft", bad), false, name);
});

test("PlanStartDocument@1 and PlanStartResult", () => {
  const document = {
    schemaVersion: 1,
    id: "4f9c1d2e-0000-4000-8000-000000000001",
    purpose: "plan_card",
    organizationId: "org_a",
    workspaceId: "workspace_a",
    actor: human,
    draft: { messageId: "message_a", revision: 1, digest },
    target: { kind: "new_project", dueAt: "2026-12-04T00:00:00Z" },
    records: {
      goal: {
        objective: "Everyday Tote in AI answers",
        dueAt: "2026-12-04T00:00:00Z",
        areaTemplateId: null,
        successCriteria: [
          {
            description: "Page complete",
            verificationCapabilityId: null,
            evidenceRequired: false,
            key: "facts",
            measure: checklist,
          },
        ],
      },
      project: { title: "Everyday Tote in AI answers", pin: true },
      tasks: [
        {
          stepKey: "channel",
          objective: "Check the AI channel",
          assignee: { kind: "person", principalId: "principal_maya" },
        },
      ],
      repeating: [],
    },
    estimate: { creditsLow: 60, creditsHigh: 100 },
    grantSummaryDigest: digest,
    contextTaint: "none",
    createdAt: at,
    expiresAt: "2026-10-24T10:35:00Z",
  };
  assert.equal(ok("PlanStartDocument", document), true);
  for (const [name, bad] of [
    ["an agent actor", { ...document, actor: { ...human, kind: "agent" } }],
    ["grants", { ...document, grants: [] }],
    ["a role", { ...document, role: "owner" }],
    ["an unknown purpose", { ...document, purpose: "install" }],
  ])
    assert.equal(ok("PlanStartDocument", bad), false, name);
  const result = {
    goalId: "goal_a",
    projectId: "project_a",
    taskIds: ["task_a"],
    routineIds: [],
    runs: [{ stepKey: "checkup", status: "not_started", reason: "agent_loop_off" }],
  };
  assert.equal(ok("PlanStartResult", result), true);
  assert.equal(
    ok("PlanStartResult", {
      ...result,
      runs: [{ stepKey: "checkup", status: "running", reason: null }],
    }),
    false,
  );
});

const message = (author, parts, origin) => ({
  schemaVersion: 1,
  id: "message_a",
  organizationId: "org_a",
  workspaceId: "workspace_a",
  storeId: null,
  revision: 1,
  createdAt: at,
  updatedAt: at,
  conversationId: "conversation_a",
  position: "p".repeat(43),
  author,
  status: "completed",
  parts,
  replyToMessageId: null,
  restrictedSources: [],
  contextTaint: "none",
  origin,
});

test("the five part kinds, the system author and the coordinator_turn origin", () => {
  const agent = {
    kind: "agent",
    principalId: "agent_coordinator",
    organizationId: "org_a",
    workspaceId: "workspace_a",
    membershipId: null,
    installationId: "installation_coordinator",
    mandateId: null,
  };
  const card = { kind: "plan_card", draft: { id: "draft_a", revision: 1, digest } };
  const change = { ...card, kind: "plan_change_card", projectId: "project_a" };
  const choice = {
    kind: "choice_question",
    questionId: "question_a",
    prompt: "Which product?",
    options: [
      { id: "tote", label: "Everyday Tote" },
      { id: "shirt", label: "Linen Shirt" },
    ],
    picker: "product",
  };
  const update = {
    kind: "project_update",
    projectId: "project_a",
    goalId: "goal_a",
    weekOf: "2026-10-26",
  };
  const done = {
    kind: "checkup_done",
    taskId: "task_a",
    reportId: "report_a",
    counts: { checked: 12, missing: 3, questions: 1 },
    nextSteps: ["add_photo", "ask_reviews"],
  };
  const turn = { kind: "coordinator_turn", runId: "run_a" };
  const askTurn = { kind: "ask_turn", turnId: "turn_a" };
  const valid = (m) => ok("Message", m);
  // Valid: the Coordinator's cards and questions; the system's update and check-up card.
  assert.equal(valid(message(agent, [card], turn)), true, "card");
  assert.equal(valid(message(agent, [change], turn)), true, "change");
  assert.equal(valid(message(agent, [choice], askTurn)), true, "choice in an Ask");
  assert.equal(valid(message({ kind: "system" }, [update], null)), true, "update");
  assert.equal(valid(message({ kind: "system" }, [done], null)), true, "check-up done");
  // Invalid: a system author with text, a card from a person or the system, an update
  // from an agent, a system message with an origin, an unknown origin.
  const text = { kind: "text", text: "Morrow wrote this" };
  for (const [name, bad] of [
    ["system text", message({ kind: "system" }, [update, text], null)],
    ["system card", message({ kind: "system" }, [card], null)],
    ["system origin", message({ kind: "system" }, [update], turn)],
    ["human card", message(human, [card], null)],
    ["agent update", message(agent, [update], turn)],
    ["agent check-up", message(agent, [done], turn)],
    ["streaming system", { ...message({ kind: "system" }, [update], null), status: "streaming" }],
    ["unknown origin", message(agent, [card], { kind: "schedule", runId: "run_a" })],
    ["one option", message(agent, [{ ...choice, options: [choice.options[0]] }], turn)],
    ["update with a value", message({ kind: "system" }, [{ ...update, value: 5 }], null)],
    ["check-up text", message({ kind: "system" }, [{ ...done, summary: "report text" }], null)],
    ["service author", message({ ...agent, kind: "service" }, [card], turn)],
  ])
    assert.equal(valid(bad), false, name);
});

test("@Morrow: a coordinator mention with request ask, human-authored only", () => {
  const mention = { kind: "mention", target: { kind: "coordinator" }, request: { kind: "ask" } };
  assert.equal(ok("MentionPart", mention), true);
  assert.equal(ok("MentionTarget", { kind: "coordinator" }), true);
  assert.equal(ok("MentionRequest", { kind: "ask" }), true);
  for (const bad of [
    { ...mention, request: { kind: "delegate", objective: "do it" } },
    { ...mention, request: { kind: "notify" } },
    { ...mention, target: { kind: "coordinator", installationId: "installation_a" } },
    { kind: "mention", target: { kind: "human", principalId: "p" }, request: { kind: "ask" } },
  ])
    assert.equal(ok("MentionPart", bad), false, JSON.stringify(bad));
  assert.equal(
    ok(
      "Message",
      message(human, [{ kind: "text", text: "@Morrow plan next steps" }, mention], null),
    ),
    true,
  );
  const agent = {
    kind: "agent",
    principalId: "agent_a",
    organizationId: "org_a",
    workspaceId: "workspace_a",
    membershipId: null,
    installationId: "installation_a",
    mandateId: null,
  };
  assert.equal(
    ok("Message", message(agent, [mention], { kind: "coordinator_turn", runId: "run_a" })),
    false,
    "an agent never mentions",
  );
  // A client may post the mention, never a card or a system part.
  assert.equal(validateDefinition("core-v1.1", "MessagePartInput", mention), true);
  for (const kind of ["plan_card", "choice_question", "project_update", "checkup_done"])
    assert.equal(validateDefinition("core-v1.1", "MessagePartInput", { kind }), false, kind);
});

test("the two human_only goal capabilities and the routine's goal record", () => {
  const byId = new Map(catalogue.capabilities.map((c) => [c.id, c]));
  for (const id of ["workspace.goal.revise", "workspace.goal.measure.record"]) {
    const c = byId.get(id);
    assert.equal(c.executor, "human_only", id);
    assert.equal(c.effect, "internal_write", id);
    assert.equal(c.review_required, false, id);
    assert.equal(c.kill_switch, false, id);
  }
  const criteria = [
    {
      description: "12 of 12 facts",
      verificationCapabilityId: null,
      evidenceRequired: false,
      key: "facts",
      measure: checklist,
    },
  ];
  const revise = {
    goalId: "goal_a",
    expectedRevision: 1,
    objective: "Everyday Tote in AI answers",
    dueAt: "2026-12-04T00:00:00Z",
    successCriteria: criteria,
  };
  assert.equal(validateCapabilityInput("workspace.goal.revise", revise), true);
  assert.equal(validateCapabilityInput("workspace.goal.revise", { ...revise, owner: "p" }), false);
  assert.equal(validateCapabilityOutput("workspace.goal.revise", { revision: 2 }), true);
  const record = {
    goalId: "goal_a",
    key: "named",
    productId: "product:1",
    assistant: "chatgpt",
    answers: ["named_this_product"],
  };
  assert.equal(validateCapabilityInput("workspace.goal.measure.record", record), true);
  for (const bad of [
    { ...record, value: 5 },
    { ...record, startRef: "value_0" },
    { ...record, answers: [] },
    { ...record, assistant: "claude" },
  ])
    assert.equal(validateCapabilityInput("workspace.goal.measure.record", bad), false);
  assert.equal(
    validateCapabilityOutput("workspace.goal.measure.record", {
      valueId: "value_1",
      counted: false,
    }),
    true,
  );
  const scheduleRef = {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: null,
    kind: "schedule",
    id: "schedule_a",
    revision: 1,
    digest,
  };
  const mandateRef = { ...scheduleRef, kind: "mandate", id: "mandate_a" };
  const configure = {
    installationId: "installation_a",
    schedule: scheduleRef,
    mandate: mandateRef,
    goalId: "goal_a",
    goalKey: "cover",
  };
  assert.equal(validateCapabilityInput("workspace.routine.configure", configure), true);
  assert.equal(
    validateCapabilityInput("workspace.routine.configure", { ...configure, goalKey: null }),
    true,
  );
  const { goalId: _goal, goalKey: _key, ...v1Body } = configure;
  assert.equal(validateCapabilityInput("workspace.routine.configure", v1Body), false);
});
