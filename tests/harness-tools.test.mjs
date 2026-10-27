// Plan row H5 (ADR-0041 items 14, 16, 17, 21, 22 and 24): the closed-input code rules of tool
// catalogue version 4's harness, memory and orchestration tools, which the tool-call step runs
// after the full ToolInput definition. A strict input carries no cross-field rule, so these
// are code's: a breach is the call's invalid_input (returned to the model), never an ended run;
// a tool the context does not offer was an invalid output and throws. None of them decides
// authority: the loop's dispatch checks every id against SQL.
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkToolInputInContext,
  contextCheckpointInputValid,
  memoryReadInputValid,
  resultWriteInputValid,
  runCompleteInputValid,
  runPlanChangeValid,
  runPlanInputValid,
  runWaitInputValid,
} from "../packages/policy/src/harness-tools.ts";
import { ToolCatalogueError } from "../packages/policy/src/tool-catalogue.ts";
import {
  fakeAgentAskInput,
  fakeAgentMapInput,
  fakeContextCheckpointInput,
  fakeIds,
  fakeMemoryReadInput,
  fakeResultWriteInput,
  fakeRunCompleteChild,
  fakeRunCompleteInput,
  fakeRunPlanInput,
  fakeRunWaitInput,
} from "../packages/policy/src/agent-platform-fakes.ts";

const ok = { ok: true };
const invalid = { ok: false, outcome: "invalid_input", refusal: "input_invalid" };
const edit = (value, change) => {
  const copy = structuredClone(value);
  change(copy);
  return copy;
};
const plan = (change = () => {}) => edit(fakeRunPlanInput(), change);
const change = (fields) => ({
  kind: "add_note",
  itemKey: null,
  status: null,
  reason: null,
  evidence: [],
  phase: null,
  item: null,
  note: null,
  followThrough: null,
  criterion: null,
  ...fields,
});
const update = (...changes) => ({ action: "update", plan: null, changes });

test("every fake input passes in the context that is offered it", () => {
  for (const [name, input, context] of [
    ["agent.ask", fakeAgentAskInput(), "coordinator"],
    ["agent.map", fakeAgentMapInput(), "coordinator"],
    ["run.plan", fakeRunPlanInput(), "coordinator"],
    ["run.complete", fakeRunCompleteInput(), "coordinator"],
    ["run.complete", fakeRunCompleteChild(), "call"],
    ["run.wait", fakeRunWaitInput(), "coordinator"],
    ["result.write", fakeResultWriteInput(), "call"],
    ["memory.read", fakeMemoryReadInput(), "coordinator"],
    ["context.checkpoint", fakeContextCheckpointInput(), "routed"],
  ])
    assert.deepEqual(checkToolInputInContext(name, input, context), ok, `${name} ${context}`);
  // A tool its context is not offered was an invalid output: the step never dispatches it.
  for (const [name, context] of [
    ["result.write", "coordinator"],
    ["run.wait", "call"],
    ["agent.ask", "routed"],
    ["memory.suggest", "call"],
    ["agent.result.read", "coordinator"],
    ["result.submit", "call"],
  ])
    assert.throws(
      () => checkToolInputInContext(name, {}, context),
      ToolCatalogueError,
      `${name} ${context}`,
    );
  // The full definition runs first: an extra field is invalid before any code rule.
  assert.deepEqual(
    checkToolInputInContext("run.wait", { ...fakeRunWaitInput(), budget: 5 }, "coordinator"),
    invalid,
  );
});

test("run.plan: set takes a plan, update changes, read neither; understood and steps are Morrow's only", () => {
  assert.ok(runPlanInputValid(fakeRunPlanInput(), "coordinator"));
  assert.ok(runPlanInputValid({ action: "read", plan: null, changes: null }, "routed"));
  for (const [name, input, context] of [
    ["set without a plan", { action: "set", plan: null, changes: null }, "coordinator"],
    [
      "set with changes",
      { ...fakeRunPlanInput(), changes: [change({ note: note() })] },
      "coordinator",
    ],
    ["read with a plan", { ...fakeRunPlanInput(), action: "read" }, "coordinator"],
    ["update without changes", { action: "update", plan: null, changes: null }, "coordinator"],
    // A teammate's or a hand-off's plan has no person-facing sentence or steps.
    ["understood in a hand-off", fakeRunPlanInput(), "routed"],
    ["no understood for Morrow", plan((p) => (p.plan.understood = null)), "coordinator"],
    ["no steps for Morrow", plan((p) => (p.plan.steps = null)), "coordinator"],
    [
      "a duplicate item key",
      plan((p) => (p.plan.phases[0].items[1].itemKey = "check")),
      "coordinator",
    ],
    [
      "a criterion index past the criteria",
      plan((p) => (p.plan.phases[0].items[0].criteria = [2])),
      "coordinator",
    ],
    [
      "a dependency on an unknown item",
      plan((p) => (p.plan.phases[0].items[1].dependsOn = ["ship"])),
      "coordinator",
    ],
    [
      "a dependency on itself",
      plan((p) => (p.plan.phases[0].items[0].dependsOn = ["check"])),
      "coordinator",
    ],
    [
      "a dependency cycle",
      plan((p) => (p.plan.phases[0].items[0].dependsOn = ["review"])),
      "coordinator",
    ],
    [
      "a follow-through on a proposal with a time",
      plan((p) =>
        p.plan.followThrough.push({
          itemKey: "live",
          title: "Tell them when it is live",
          condition: "proposal_applied",
          id: null,
          at: "2026-10-27T09:00:00Z",
        }),
      ),
      "coordinator",
    ],
    [
      "a follow-through key that repeats an item's",
      plan((p) =>
        p.plan.followThrough.push({
          itemKey: "check",
          title: "Tell them",
          condition: "call_finished",
          id: fakeIds.callId,
          at: null,
        }),
      ),
      "coordinator",
    ],
    [
      "seven steps",
      plan((p) =>
        p.plan.steps.push(...["4", "5", "6", "7"].map((title) => ({ title, by: "morrow" }))),
      ),
      "coordinator",
    ],
    // ADR-0040 item 4(c)'s person-facing bounds, as run.plan's own limits (the H6 merge): a
    // longer input is this call's invalid_input, never a record the store refuses.
    [
      "an understood line over 280 characters",
      plan((p) => (p.plan.understood = "x".repeat(281))),
      "coordinator",
    ],
    [
      "a step over 80 characters",
      plan((p) => (p.plan.steps[0].title = "x".repeat(81))),
      "coordinator",
    ],
    ["a step without its owner", plan((p) => delete p.plan.steps[0].by), "coordinator"],
    ["a step as plain text", plan((p) => (p.plan.steps[0] = "Check every title")), "coordinator"],
  ])
    assert.equal(runPlanInputValid(input, context), false, name);
  // The bounds themselves pass: 280 characters understood, a step of 80.
  assert.ok(
    runPlanInputValid(
      plan((p) => {
        p.plan.understood = "x".repeat(280);
        p.plan.steps[0].title = "x".repeat(80);
      }),
      "coordinator",
    ),
  );
  // A teammate's own plan, and a time follow-through, pass.
  const teammate = plan((p) => {
    p.plan.understood = null;
    p.plan.steps = null;
    p.plan.followThrough.push({
      itemKey: "recheck",
      title: "Check the stock again tomorrow",
      condition: "time",
      id: null,
      at: "2026-10-27T09:00:00Z",
    });
  });
  assert.ok(runPlanInputValid(teammate, "call"));
});

const note = () => ({ kind: "dead_end", text: "The CSV export has no SEO fields.", refs: [] });
test("run.plan changes: each kind takes its own fields; a drop says why; a criterion changes only with a reason", () => {
  for (const c of [
    change({ note: note() }),
    change({ kind: "item_status", itemKey: "check", status: "done" }),
    change({
      kind: "item_status",
      itemKey: "check",
      status: "done",
      evidence: [{ kind: "proposal", id: "proposal_fake_1" }],
    }),
    change({ kind: "item_status", itemKey: "check", status: "dropped", reason: "Not needed." }),
    change({
      kind: "add_item",
      phase: 0,
      item: { itemKey: "ship", title: "Ship", criteria: [], dependsOn: ["review"] },
    }),
    change({
      kind: "add_follow_through",
      followThrough: {
        itemKey: "live",
        title: "Tell them when it is live",
        condition: "proposal_applied",
        id: "proposal_fake_1",
        at: null,
      },
    }),
    change({
      kind: "change_criterion",
      criterion: { index: 0, text: "Every dress checked.", check: "child_outcome" },
      reason: "The person narrowed it to dresses.",
    }),
  ])
    assert.ok(runPlanChangeValid(c), JSON.stringify(c));
  for (const [name, c] of [
    ["a note with an item key", change({ note: note(), itemKey: "check" })],
    ["a status without its item", change({ kind: "item_status", status: "done" })],
    [
      "a drop without a reason",
      change({ kind: "item_status", itemKey: "check", status: "dropped" }),
    ],
    [
      "a block without a reason",
      change({ kind: "item_status", itemKey: "check", status: "blocked" }),
    ],
    [
      "evidence on a note",
      change({ note: note(), evidence: [{ kind: "task", id: fakeIds.taskId }] }),
    ],
    [
      "an added item that depends on itself",
      change({
        kind: "add_item",
        phase: 0,
        item: { itemKey: "ship", title: "Ship", criteria: [], dependsOn: ["ship"] },
      }),
    ],
    [
      "a criterion changed without a reason",
      change({
        kind: "change_criterion",
        criterion: { index: 0, text: "Anything.", check: "judgment" },
      }),
    ],
  ])
    assert.equal(runPlanChangeValid(c), false, name);
  assert.ok(runPlanInputValid(update(change({ note: note() })), "mandate"));
  assert.equal(
    runPlanInputValid(update(change({ kind: "item_status", status: "done" })), "mandate"),
    false,
  );
});

test("run.complete: a teammate gives its child form and no reply; Morrow a reply and no result", () => {
  assert.ok(runCompleteInputValid(fakeRunCompleteChild(), "call"));
  assert.ok(runCompleteInputValid(fakeRunCompleteInput(), "coordinator"));
  const routed = { ...fakeRunCompleteInput(), reply: null };
  assert.ok(runCompleteInputValid(routed, "routed"));
  assert.ok(runCompleteInputValid({ ...routed, outcome: "waiting" }, "mandate"));
  for (const [name, input, context] of [
    ["a teammate's reply", { ...fakeRunCompleteChild(), reply: "Done." }, "call"],
    ["a teammate waiting", { ...fakeRunCompleteChild(), outcome: "waiting" }, "call"],
    ["a teammate without its result", { ...fakeRunCompleteChild(), result: null }, "call"],
    [
      "needs on a done result",
      edit(fakeRunCompleteChild(), (c) => (c.result.needs = { kind: "decision", question: null })),
      "call",
    ],
    [
      "a table finding without its table",
      edit(fakeRunCompleteChild(), (c) => (c.result.findings[1].table = null)),
      "call",
    ],
    ["Morrow without a reply", { ...fakeRunCompleteInput(), reply: null }, "coordinator"],
    ["Morrow with a child form", { ...fakeRunCompleteChild(), reply: "Done." }, "coordinator"],
    ["a hand-off with a child form", fakeRunCompleteChild(), "routed"],
    [
      "a criterion reported twice",
      edit(fakeRunCompleteInput(), (c) => (c.criteria[1].index = 0)),
      "coordinator",
    ],
    ["a reply holding NUL", { ...fakeRunCompleteInput(), reply: "Done\u0000." }, "coordinator"],
    ["a code outcome", { ...fakeRunCompleteInput(), outcome: "stopped" }, "coordinator"],
    // Review H5-9: look-for-work is never offered a wait, by run.wait or by a completion.
    ["look-for-work waiting", { ...routed, outcome: "waiting" }, "look_for_work"],
  ])
    assert.equal(runCompleteInputValid(input, context), false, name);
  assert.ok(runCompleteInputValid(routed, "look_for_work"), "look-for-work completes");
  assert.deepEqual(
    checkToolInputInContext("run.complete", { ...routed, outcome: "waiting" }, "look_for_work"),
    invalid,
  );
  // Blocked and partial carry what the teammate needs.
  const blocked = edit(fakeRunCompleteChild(), (c) => {
    c.outcome = "blocked";
    c.result.needs = { kind: "grant", question: "May I read orders?" };
  });
  assert.ok(runCompleteInputValid(blocked, "call"));
});

test("run.wait: children are Morrow's; proposals by id; a time; every other field null", () => {
  const wait = (fields) => ({
    kind: "time",
    match: null,
    callIds: null,
    proposalIds: null,
    until: null,
    ...fields,
  });
  for (const [input, context] of [
    [fakeRunWaitInput(), "coordinator"],
    [wait({ kind: "children", match: "any", callIds: [fakeIds.callId] }), "coordinator"],
    [wait({ kind: "proposals", match: "all", proposalIds: ["proposal_fake_1"] }), "routed"],
    [wait({ until: "2026-10-27T09:00:00Z" }), "mandate"],
  ])
    assert.ok(runWaitInputValid(input, context), JSON.stringify(input));
  for (const [name, input, context] of [
    ["children in a hand-off", fakeRunWaitInput(), "routed"],
    ["children without a match", wait({ kind: "children" }), "coordinator"],
    [
      "children with a time",
      wait({ kind: "children", match: "all", until: "2026-10-27T09:00:00Z" }),
      "coordinator",
    ],
    ["proposals without ids", wait({ kind: "proposals", match: "all" }), "routed"],
    [
      "proposals with call ids",
      wait({
        kind: "proposals",
        match: "all",
        proposalIds: ["proposal_fake_1"],
        callIds: [fakeIds.callId],
      }),
      "routed",
    ],
    ["a time without until", wait({}), "routed"],
    ["a time with a match", wait({ until: "2026-10-27T09:00:00Z", match: "any" }), "routed"],
    ["a time as a date", wait({ until: "2026-10-27" }), "routed"],
  ])
    assert.equal(runWaitInputValid(input, context), false, name);
});

test("result.write: start with a title, kind and media type; append text or rows or close; never NUL", () => {
  const append = (fields) => ({
    itemId: fakeIds.itemId,
    title: null,
    kind: null,
    mediaType: null,
    columns: null,
    text: null,
    rows: null,
    close: false,
    ...fields,
  });
  for (const input of [
    fakeResultWriteInput(),
    { ...fakeResultWriteInput(), rows: null },
    {
      ...fakeResultWriteInput(),
      kind: "text",
      mediaType: "text/markdown",
      columns: null,
      rows: null,
      text: "# Findings\n",
    },
    append({ text: "More. ".repeat(50000) }),
    append({ rows: [["product:1002", "Silk scarf"]] }),
    append({ close: true }),
  ])
    assert.ok(resultWriteInputValid(input), JSON.stringify(input).slice(0, 80));
  for (const [name, input] of [
    ["a start without a title", { ...fakeResultWriteInput(), title: null }],
    ["a table without columns", { ...fakeResultWriteInput(), columns: null }],
    ["a table as plain text", { ...fakeResultWriteInput(), mediaType: "text/plain" }],
    ["a row one cell short", { ...fakeResultWriteInput(), rows: [["product:1001"]] }],
    ["text into a new table", { ...fakeResultWriteInput(), text: "x" }],
    [
      "columns on a text item",
      { ...fakeResultWriteInput(), kind: "text", mediaType: "text/plain", rows: null },
    ],
    ["an append that renames", append({ title: "New", text: "x" })],
    ["an append that does nothing", append({})],
    ["text and rows at once", append({ text: "x", rows: [["a", "b"]] })],
    ["NUL in text", append({ text: "a\u0000b" })],
    ["NUL in a cell", append({ rows: [["a\u0000", "b"]] })],
    ["NUL in a column", { ...fakeResultWriteInput(), columns: ["Pro\u0000duct", "Title"] }],
  ])
    assert.equal(resultWriteInputValid(input), false, name);
});

test("memory.read: one target, by label, message range, call sequence or id", () => {
  const target = (fields) => ({
    target: {
      kind: "result_item",
      id: fakeIds.itemId,
      label: null,
      sequence: null,
      fromPosition: null,
      toPosition: null,
      ...fields,
    },
    page: 1,
  });
  for (const input of [
    fakeMemoryReadInput(),
    target({}),
    target({ kind: "teammate_result", id: fakeIds.callId, sequence: 2 }),
    target({ kind: "label", id: null, label: "c17" }),
    target({ kind: "messages", id: "conversation_1", fromPosition: 3, toPosition: 9 }),
    target({ kind: "notebook_entry", id: "entry_1" }),
  ])
    assert.ok(memoryReadInputValid(input), JSON.stringify(input));
  for (const [name, input] of [
    ["a label with an id", target({ kind: "label", label: "c17" })],
    ["a label without one", target({ kind: "label", id: null })],
    ["a label outside the code labels", target({ kind: "label", id: null, label: "x17" })],
    ["a message range backwards", target({ kind: "messages", fromPosition: 9, toPosition: 3 })],
    ["a message range half open", target({ kind: "messages", fromPosition: 3 })],
    ["a sequence on an item", target({ sequence: 2 })],
    ["a range on an item", target({ fromPosition: 1, toPosition: 2 })],
    ["an item without its id", target({ id: null })],
    ["page 0", { ...target({}), page: 0 }],
  ])
    assert.equal(memoryReadInputValid(input), false, name);
});

test("context.checkpoint: narrative with code labels; never NUL", () => {
  assert.ok(contextCheckpointInputValid(fakeContextCheckpointInput()));
  for (const [name, input] of [
    ["NUL in a fact", edit(fakeContextCheckpointInput(), (c) => (c.facts[0].fact = "a\u0000b"))],
    [
      "a ref that is no label",
      edit(fakeContextCheckpointInput(), (c) => (c.done[0].refs = ["x1"])),
    ],
    [
      "an approval field",
      edit(fakeContextCheckpointInput(), (c) => (c.approvals = [{ text: "approved" }])),
    ],
    ["a status outside the list", { ...fakeContextCheckpointInput(), status: "approved" }],
  ])
    assert.equal(contextCheckpointInputValid(input), false, name);
});

test("agent.ask and agent.map through the step: a follow-up names no teammate; a map one source", () => {
  assert.deepEqual(
    checkToolInputInContext(
      "agent.ask",
      { ...fakeAgentAskInput(), installationId: null, followUpOf: fakeIds.callId },
      "coordinator",
    ),
    ok,
  );
  assert.deepEqual(
    checkToolInputInContext(
      "agent.ask",
      { ...fakeAgentAskInput(), followUpOf: fakeIds.callId },
      "coordinator",
    ),
    invalid,
  );
  assert.deepEqual(
    checkToolInputInContext(
      "agent.map",
      { ...fakeAgentMapInput(), source: { records: null, itemId: null } },
      "coordinator",
    ),
    invalid,
  );
  assert.deepEqual(
    checkToolInputInContext("run.complete", { ...fakeRunCompleteChild(), reply: "x" }, "call"),
    invalid,
  );
});
