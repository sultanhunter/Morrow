// ADR-0037 PR 2 and plan row H5 (ADR-0041 items 19 to 24 and 34): teammate calls' results in
// code and the conformance of their deterministic fakes. TeammateResult@1 has no character cap:
// what does not fit the stored record is kept whole as a result item and read page by page, so
// joining the pages gives back exactly what the teammate wrote; the created and unresolved
// lists are uncapped too. Code checks first: criteria met on evidence that does not resolve are
// unverified, next is code's, and a run that ends without run.complete keeps its work as
// partial. Morrow opens only items of results its own run received; a teammate only those named
// in its brief that its calling run received; nothing customer-tagged reaches Morrow. Each call
// is admitted alone under the kernel's 32 children (then a check-in) and the balance (credits
// only: a call it cannot cover parks the job); follow-ups reopen an idle child; result.write
// builds items across turns; a dispatch over unknown outcomes is refused, a follow-up's too.
// Taint only joins and never truncates: every kind, 256 sources inline and a count of the rest;
// read tags only join across a child's sequences, and a customer-tagged result releases its
// child.
import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptTeammateResult,
  agentAskValid,
  agentMapValid,
  buildTeammateResult,
  cleanTaint,
  codeOutcome,
  coordinatorMayOpen,
  csvText,
  joinReadTags,
  joinRunTaint,
  nextFor,
  readTagLimit,
  receivedItemIds,
  resultItemPage,
  resultItemPageBytes,
  retryBlocked,
  runTaintSourceLimit,
  runTaintValid,
  tableItemDraft,
  tablePages,
  taintFrom,
  teammateBrief,
  teammateMayOpen,
  teammateResultInputValid,
  teammateResultMaxBytes,
  teammateResultValid,
  teamSwitchState,
  textPages,
  toolResultMaxBytes,
} from "../packages/policy/src/teammates.ts";
import {
  createFakeResultItemStore,
  createFakeTeammateRunner,
  maximumChildrenPerEnvelope,
} from "../packages/policy/src/teammate-fakes.ts";
import {
  fakeAgentAskInput,
  fakeAgentMapInput,
  fakeIds,
  fakeRunCompleteChild,
  fakeTaint,
  fakeTeammateBrief,
  fakeTeammateBriefInput,
  fakeTeammateResult,
} from "../packages/policy/src/agent-platform-fakes.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

const at = "2026-10-26T09:03:00.000Z";
const productTag = { storeId: fakeIds.storeId, capability: "catalog.products.read" };
const knowledgeTag = { storeId: null, capability: "workspace.knowledge.read" };
const customerTag = { storeId: fakeIds.storeId, capability: "support.case.read" };
const ordersTag = { storeId: fakeIds.storeId, capability: "orders.read" };
const facts = (change = () => {}) => {
  const f = {
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    parentRunId: fakeIds.runId,
    toolUseId: fakeIds.toolUseId,
    callId: fakeIds.callId,
    sequence: 1,
    mode: "ask",
    runId: fakeIds.callRunId,
    taskId: fakeIds.callTaskId,
    installationId: fakeIds.listingsInstallationId,
    endReason: "completed",
    doneCriteria: 2,
    given: structuredClone(fakeTeammateBriefInput().records),
    created: [{ kind: "proposal", id: "proposal_fake_1" }],
    written: [],
    recordedFindings: [],
    unresolved: [],
    plan: { itemsDone: 3, itemsTotal: 3 },
    checkpointId: null,
    verifierVerdict: "not_run",
    readTags: [productTag, knowledgeTag],
    taint: structuredClone(fakeTaint()),
    completedAt: fakeTeammateResult().completedAt,
  };
  change(f);
  return f;
};
const complete = (change = () => {}) => {
  const c = structuredClone(fakeRunCompleteChild());
  change(c);
  return c;
};
const memorySink = () => {
  const stored = [];
  const sink = async (draft) => {
    stored.push(draft);
    return "item_mem_" + stored.length;
  };
  return { stored, sink };
};
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const joined = (pages) => pages.join("");
// Past the stored record's bound, so a part must move into an item.
const huge = (unit) => unit.repeat(Math.ceil((teammateResultMaxBytes + 4096) / unit.length));
const readAll = (draft, itemId = "item_x") => {
  const pages = [];
  for (let page = 1; page <= draft.pageCount; page++) {
    const p = resultItemPage(
      { itemId, kind: draft.kind, title: draft.title, content: draft.content },
      page,
    );
    assert.ok(validateCurrentDefinition("ResultItemPage", p));
    assert.ok(bytes(p) <= toolResultMaxBytes, "a page fits one tool result");
    pages.push(p);
  }
  return pages;
};

test("the team switches are committed off", () => {
  assert.deepEqual(teamSwitchState(), { teammateCalls: "off", agentCards: "off" });
});

test("a result that fits is the fake, everything inline; no item is stored", async () => {
  const { stored, sink } = memorySink();
  const result = await buildTeammateResult(facts(), complete(), sink);
  assert.deepEqual(result, fakeTeammateResult());
  assert.equal(stored.length, 0);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.findings[0]));
  assert.equal(acceptTeammateResult(result), "ok");
  assert.ok(bytes(result) <= teammateResultMaxBytes);
});

test("nothing is cut: a summary past the record's bound becomes an item, read back exactly", async () => {
  const long = huge('Ünïcode 🌿 and "quotes" and a\tcontrol.\n');
  const { stored, sink } = memorySink();
  const result = await buildTeammateResult(
    facts(),
    complete((c) => (c.result.summary = long)),
    sink,
  );
  assert.ok(bytes(result) <= teammateResultMaxBytes);
  assert.deepEqual(result.summary, { kind: "item", itemId: "item_mem_1" });
  assert.equal(stored.length, 1);
  assert.deepEqual(result.items, [
    {
      itemId: "item_mem_1",
      kind: "text",
      title: "Summary",
      sizeBytes: Buffer.byteLength(long, "utf8"),
      pageCount: stored[0].pageCount,
    },
  ]);
  assert.equal(joined(readAll(stored[0]).map((p) => p.content.text)), long);
  const item = { itemId: "x", kind: "text", title: "S", content: stored[0].content };
  assert.equal(resultItemPage(item, stored[0].pageCount + 1), "page_out_of_range");
  assert.equal(resultItemPage(item, 0), "page_out_of_range");
});

test("text pages cut only between characters and count JSON escapes", () => {
  assert.deepEqual(textPages(""), [""]);
  const emoji = "🌿".repeat(4000);
  const pages = textPages(emoji);
  assert.equal(joined(pages), emoji);
  for (const page of pages) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(page), "never ends inside a surrogate pair");
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") - 2 <= resultItemPageBytes);
  }
  // Control characters take six bytes each as JSON: a page of them still fits.
  const controls = "\u0001".repeat(5000);
  for (const page of textPages(controls))
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") - 2 <= resultItemPageBytes);
  assert.equal(joined(textPages(controls)), controls);
});

test("a large table finding becomes a table item read by rows; an oversize row falls back to CSV", async () => {
  const rows = Array.from({ length: 8000 }, (_, i) => [
    "product:" + (1000 + i),
    "Linen dress number " + i,
  ]);
  const { stored, sink } = memorySink();
  const result = await buildTeammateResult(
    facts(),
    complete((c) => (c.result.findings[1].table.rows = rows)),
    sink,
  );
  assert.ok(teammateResultValid(result));
  const tableFinding = result.findings[1];
  assert.equal(tableFinding.table.kind, "item");
  const draft = stored.find((d) => d.kind === "table");
  assert.ok(draft.pageCount > 1);
  const back = [];
  for (const p of readAll(draft, tableFinding.table.itemId)) {
    assert.equal(p.content.firstRow, back.length + 1);
    back.push(...p.content.rows);
  }
  assert.deepEqual(back, rows);
  // One row larger than a page: the table is kept whole as CSV text instead.
  const wide = { columns: ["A"], rows: [["x".repeat(resultItemPageBytes + 10)]] };
  assert.equal(tablePages(wide), null);
  const csv = tableItemDraft("Wide", wide);
  assert.equal(csv.kind, "text");
  assert.equal(csv.mediaType, "text/csv");
  assert.equal(csv.content.text, csvText(wide));
  assert.equal(csvText({ columns: ["a,b"], rows: [['say "hi"']] }), '"a,b"\r\n"say ""hi"""');
  assert.throws(() => tablePages({ columns: ["A", "B"], rows: [["only one"]] }), /INPUT_INVALID/);
});

test("many large findings: they move whole into one JSON item when moving parts is not enough", async () => {
  // Titles never move on their own: 256 long titles exceed the record's bound together.
  const findings = Array.from({ length: 256 }, (_, i) => ({
    kind: "fact",
    title: `Finding ${i}: ` + "a product title that is long enough to matter. ".repeat(25),
    detail: "",
    records: [{ kind: "product", id: "product:" + (1000 + i) }],
    value: null,
    unit: null,
    table: null,
  }));
  const { stored, sink } = memorySink();
  const result = await buildTeammateResult(
    facts(),
    complete((c) => (c.result.findings = findings)),
    sink,
  );
  assert.ok(bytes(result) <= teammateResultMaxBytes);
  assert.deepEqual(result.findings, []);
  assert.equal(result.items.length, stored.length);
  const all = stored.find((d) => d.mediaType === "application/json" && d.title.startsWith("Find"));
  assert.deepEqual(JSON.parse(all.content.text), findings);
  assert.equal(all.title, "Findings (256)");
});

test("the same input stores the same items in the same order", async () => {
  const input = complete((c) => {
    c.result.summary = huge("S");
    c.result.findings[1].detail = huge("D");
  });
  const a = memorySink();
  const b = memorySink();
  const first = await buildTeammateResult(facts(), input, a.sink);
  const second = await buildTeammateResult(facts(), structuredClone(input), b.sink);
  assert.deepEqual(first, second);
  assert.deepEqual(
    a.stored.map((d) => d.title),
    ["Summary", "Proposed titles"],
  );
});

test("created and unresolved are uncapped: a long list moves whole into an item", async () => {
  const created = Array.from({ length: 9000 }, (_, i) => ({
    kind: "proposal",
    id: `proposal_${i}`,
  }));
  const unresolved = Array.from({ length: 4000 }, (_, i) => ({
    subject: { kind: "product", id: `product:${i}` },
    operation: { kind: "gateway_operation", id: `op_${i}` },
  }));
  const { stored, sink } = memorySink();
  const result = await buildTeammateResult(
    facts((f) => {
      f.created = created;
      f.unresolved = unresolved;
    }),
    complete((c) => (c.outcome = "partial")),
    sink,
  );
  assert.ok(teammateResultValid(result));
  assert.equal(result.created.kind, "item");
  assert.equal(result.created.count, 9000);
  const createdItem = stored.find((d) => d.title === "Records created (9000)");
  assert.deepEqual(JSON.parse(joined(readAll(createdItem).map((p) => p.content.text))), created);
  assert.equal(result.unresolved.kind, "item");
  assert.equal(result.unresolved.count, 4000);
  // Unknown outcomes come first: nothing is retried over them.
  assert.equal(result.next, "do_not_retry");
});

test("ADR-0041 item 23: a run that ends without run.complete keeps its work as partial; code sets every other outcome", async () => {
  for (const [endReason, outcome] of [
    ["turn_limit", "no_result"],
    ["wall_time", "no_result"],
    ["completed", "no_result"],
    ["stopped", "stopped"],
    ["lease_ended", "stopped"],
    ["spend_limit", "stopped"],
    ["provider_error", "failed"],
    ["invalid_output", "failed"],
  ]) {
    assert.equal(codeOutcome(endReason, false), outcome, endReason);
    assert.equal(codeOutcome(endReason, true), "partial", endReason);
    const result = await buildTeammateResult(
      facts((f) => {
        f.endReason = endReason;
        f.created = [];
      }),
      null,
      memorySink().sink,
    );
    assert.equal(result.outcome, outcome);
    assert.equal(result.summary, null);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.created, { kind: "list", records: [] });
  }
  // Records it created, items it wrote or findings it noted: partial, every one kept.
  const stoppedWithWork = await buildTeammateResult(
    facts((f) => (f.endReason = "stopped")),
    null,
    memorySink().sink,
  );
  assert.equal(stoppedWithWork.outcome, "partial");
  assert.deepEqual(stoppedWithWork.created, fakeTeammateResult().created);
  assert.equal(stoppedWithWork.next, "follow_up");
  const noted = complete().result.findings;
  const withFindings = await buildTeammateResult(
    facts((f) => {
      f.endReason = "provider_error";
      f.created = [];
      f.recordedFindings = noted;
    }),
    null,
    memorySink().sink,
  );
  assert.equal(withFindings.outcome, "partial");
  assert.equal(withFindings.findings.length, noted.length);
  // run.complete given, then the run was stopped before it closed: everything kept, partial.
  const late = await buildTeammateResult(
    facts((f) => (f.endReason = "stopped")),
    complete(),
    memorySink().sink,
  );
  assert.equal(late.outcome, "partial");
  assert.deepEqual(late.summary, fakeTeammateResult().summary);
  assert.equal(late.findings.length, 2);
  // blocked goes with every end reason, and keeps what the teammate needs.
  const blocked = await buildTeammateResult(
    facts((f) => (f.endReason = "lease_ended")),
    complete((c) => {
      c.outcome = "blocked";
      c.result.needs = { kind: "decision", question: "Which collection comes first?" };
    }),
    memorySink().sink,
  );
  assert.equal(blocked.outcome, "blocked");
  assert.deepEqual(blocked.needs, {
    kind: "decision",
    question: { kind: "text", text: "Which collection comes first?" },
  });
  assert.equal(blocked.next, "ask_person");
});

test("code checks first: criteria by index, unverified evidence, verification and next", async () => {
  // One criterion unreported (unknown), one met on evidence the run never produced or got.
  const result = await buildTeammateResult(
    facts(),
    complete((c) => {
      c.criteria = [{ index: 0, status: "met", evidence: [{ kind: "product", id: "product:9" }] }];
    }),
    memorySink().sink,
  );
  assert.deepEqual(
    result.criteria.map((c) => [c.index, c.status]),
    [
      [0, "unverified"],
      [1, "unknown"],
    ],
  );
  assert.deepEqual(result.verification, {
    codeChecksPassed: 0,
    codeChecksFailed: 1,
    verifierVerdict: "not_run",
  });
  assert.equal(result.next, "follow_up", "done, but not every criterion met");
  // Evidence resolves to what the run was given, created or wrote.
  const written = { itemId: "item_w", kind: "text", title: "Notes", sizeBytes: 3, pageCount: 1 };
  const cited = await buildTeammateResult(
    facts((f) => (f.written = [written])),
    complete((c) => {
      c.criteria = [
        { index: 0, status: "met", evidence: [{ kind: "result_item", id: "item_w" }] },
        { index: 1, status: "met", evidence: [{ kind: "task", id: fakeIds.taskId }] },
      ];
      c.result.items = ["item_w"];
    }),
    memorySink().sink,
  );
  assert.deepEqual(
    cited.criteria.map((c) => c.status),
    ["met", "met"],
  );
  assert.deepEqual(cited.items, [written]);
  assert.equal(cited.next, "none");
  // The model cannot cite a criterion the brief lacks, report one twice, or cite an item it
  // never wrote.
  for (const change of [
    (c) => (c.criteria = [{ index: 2, status: "met", evidence: [] }]),
    (c) =>
      (c.criteria = [
        { index: 0, status: "met", evidence: [] },
        { index: 0, status: "not_met", evidence: [] },
      ]),
    (c) => (c.result.items = ["item_never_written"]),
    (c) => (c.result.needs = { kind: "grant", question: null }),
    (c) => (c.outcome = "waiting"),
    (c) => (c.reply = "Done."),
    (c) => (c.result = null),
  ])
    await assert.rejects(
      buildTeammateResult(facts(), complete(change), memorySink().sink),
      /TEAMMATE_RESULT_INPUT_INVALID/,
    );
  for (const [outcome, endReason, criteria, unresolved, next] of [
    ["done", "completed", [{ status: "met" }], false, "none"],
    ["done", "completed", [{ status: "not_met" }], false, "follow_up"],
    ["nothing_found", "completed", [], false, "none"],
    ["partial", "stopped", [], false, "follow_up"],
    ["blocked", "completed", [], false, "ask_person"],
    ["cannot_do", "completed", [], false, "reroute"],
    ["stopped", "stopped", [], false, "do_not_retry"],
    ["failed", "provider_error", [], false, "retry_later"],
    ["failed", "invalid_output", [], false, "rebrief"],
    ["no_result", "turn_limit", [], false, "rebrief"],
    ["done", "completed", [{ status: "met" }], true, "do_not_retry"],
  ])
    assert.equal(
      nextFor(outcome, endReason, criteria, unresolved),
      next,
      `${outcome} ${endReason}`,
    );
});

test("review mode: a verdict per criterion, unreported ones unknown; never in an ask", async () => {
  const review = await buildTeammateResult(
    facts((f) => (f.mode = "review")),
    complete((c) => {
      c.result.verdicts = [
        {
          index: 1,
          verdict: "fail",
          evidence: [{ kind: "proposal", id: "proposal_fake_1" }],
          note: "One proposed title is still 82 characters.",
        },
      ];
    }),
    memorySink().sink,
  );
  assert.equal(review.mode, "review");
  assert.deepEqual(
    review.verdicts.map((v) => [v.index, v.verdict]),
    [
      [0, "unknown"],
      [1, "fail"],
    ],
  );
  assert.ok(teammateResultValid(review));
  await assert.rejects(
    buildTeammateResult(
      facts(),
      complete(
        (c) => (c.result.verdicts = [{ index: 0, verdict: "pass", evidence: [], note: null }]),
      ),
      memorySink().sink,
    ),
    /TEAMMATE_RESULT_INPUT_INVALID/,
  );
});

test("run.complete's child form: metric values, table findings, row widths and one verdict per criterion", () => {
  const child = () => structuredClone(fakeRunCompleteChild().result);
  assert.ok(teammateResultInputValid(child()));
  for (const change of [
    (s) => (s.findings[1].value = 3),
    (s) => (s.findings[0].table = { columns: ["A"], rows: [] }),
    (s) => (s.findings[1].table = null),
    (s) => s.findings[1].table.rows.push(["only one cell"]),
    (s) => (s.capabilities = []),
    (s) => (s.created = []),
    (s) =>
      (s.verdicts = [
        { index: 0, verdict: "pass", evidence: [], note: null },
        { index: 0, verdict: "fail", evidence: [], note: null },
      ]),
  ]) {
    const value = child();
    change(value);
    assert.equal(teammateResultInputValid(value), false);
  }
});

test("TeammateResult@1's code rules: listed items, named items, criteria once, taint kinds, and the customer tag refused", () => {
  const result = structuredClone(fakeTeammateResult());
  assert.ok(teammateResultValid(result));
  const named = structuredClone(result);
  named.summary = { kind: "item", itemId: "item_unlisted" };
  assert.equal(teammateResultValid(named), false, "a named item must be listed");
  const createdItem = structuredClone(result);
  createdItem.created = { kind: "item", itemId: "item_unlisted", count: 3 };
  assert.equal(teammateResultValid(createdItem), false, "the created list's item is listed");
  const twice = structuredClone(result);
  const ref = { itemId: "item_1", kind: "text", title: "T", sizeBytes: 1, pageCount: 1 };
  twice.items = [ref, ref];
  assert.equal(teammateResultValid(twice), false);
  const criteria = structuredClone(result);
  criteria.criteria[1].index = 0;
  assert.equal(teammateResultValid(criteria), false, "each criterion once");
  const kinds = structuredClone(result);
  kinds.taint.kinds = ["upload"];
  assert.equal(teammateResultValid(kinds), false, "every listed source's kind is a kind");
  const tagged = structuredClone(result);
  tagged.readTags.push(customerTag);
  assert.ok(teammateResultValid(tagged), "valid, but never enters Morrow's context");
  assert.equal(acceptTeammateResult(tagged), "result_customer_tagged");
  assert.equal(acceptTeammateResult({ ...result, extra: 1 }), "result_invalid");
});

test("opening items: Morrow only from results its run received; a teammate only what its brief names", () => {
  const item = { itemId: "item_a", readTags: [productTag] };
  const received = receivedItemIds([
    {
      ...fakeTeammateResult(),
      items: [{ itemId: "item_a", kind: "text", title: "T", sizeBytes: 1, pageCount: 1 }],
    },
  ]);
  assert.equal(coordinatorMayOpen(item, received), "ok");
  assert.equal(coordinatorMayOpen({ ...item, itemId: "item_b" }, received), "item_not_received");
  assert.equal(
    coordinatorMayOpen({ ...item, readTags: [customerTag] }, received),
    "result_customer_tagged",
  );
  const brief = { ...fakeTeammateBrief(), records: [{ kind: "result_item", id: "item_a" }] };
  assert.equal(teammateMayOpen(item, brief, received), "ok");
  assert.equal(
    teammateMayOpen(item, fakeTeammateBrief(), received),
    "item_not_received",
    "not named",
  );
  assert.equal(
    teammateMayOpen(item, brief, new Set()),
    "item_not_received",
    "not received by the caller",
  );
  // An id of another kind with the same text is not a result item.
  const asTask = { ...fakeTeammateBrief(), records: [{ kind: "task", id: "item_a" }] };
  assert.equal(teammateMayOpen(item, asTask, received), "item_not_received");
});

test("ADR-0041 item 21: code builds the brief a teammate receives; the model writes only the input", () => {
  const request = fakeTeammateBrief().request;
  const brief = teammateBrief(fakeTeammateBriefInput(), { request, mode: "ask", followUpOf: null });
  assert.deepEqual(brief, fakeTeammateBrief());
  assert.ok(Object.isFrozen(brief) && Object.isFrozen(brief.request));
  // A mandate episode has no person's words; a review and a follow-up are code's to set.
  const review = teammateBrief(fakeTeammateBriefInput(), {
    request: null,
    mode: "review",
    followUpOf: fakeIds.callId,
  });
  assert.equal(review.request, null);
  assert.equal(review.mode, "review");
  assert.equal(review.followUpOf, fakeIds.callId);
  // The requester's words have no character cap.
  const long = { ...request, text: "Keep them short. ".repeat(20000) };
  assert.equal(
    teammateBrief(fakeTeammateBriefInput(), { request: long, mode: "ask", followUpOf: null })
      .request.text,
    long.text,
  );
  // An input that tries to carry code's fields, or no done criterion, builds nothing.
  for (const input of [
    { ...fakeTeammateBriefInput(), request },
    { ...fakeTeammateBriefInput(), mode: "ask" },
    { ...fakeTeammateBriefInput(), doneCriteria: [] },
    "do it",
  ])
    assert.equal(teammateBrief(input, { request, mode: "ask", followUpOf: null }), null);
  // agent.ask names a teammate exactly when it is no follow-up; agent.map one source.
  assert.ok(agentAskValid(fakeAgentAskInput()));
  assert.ok(
    agentAskValid({ ...fakeAgentAskInput(), installationId: null, followUpOf: fakeIds.callId }),
  );
  assert.equal(agentAskValid({ ...fakeAgentAskInput(), followUpOf: fakeIds.callId }), false);
  assert.equal(agentAskValid({ ...fakeAgentAskInput(), installationId: null }), false);
  assert.equal(agentAskValid({ ...fakeAgentAskInput(), mode: "route" }), false);
  assert.ok(agentMapValid(fakeAgentMapInput()));
  const map = fakeAgentMapInput();
  assert.equal(agentMapValid({ ...map, source: { records: null, itemId: null } }), false);
  assert.equal(
    agentMapValid({ ...map, source: { records: map.source.records, itemId: fakeIds.itemId } }),
    false,
  );
  assert.ok(agentMapValid({ ...map, source: { records: null, itemId: fakeIds.itemId } }));
  assert.equal(agentMapValid({ ...map, batchSize: 51 }), false);
  // ADR-0041 item 23: a dispatch over subjects with unknown outcomes is refused.
  const unresolved = [
    {
      subject: { kind: "product", id: "product:1001" },
      operation: { kind: "gateway_operation", id: "op_1" },
    },
  ];
  assert.equal(retryBlocked(fakeTeammateBriefInput().records, unresolved), "retry_blocked");
  assert.equal(retryBlocked([{ kind: "product", id: "product:2002" }], unresolved), "ok");
  assert.equal(retryBlocked([{ kind: "task", id: "product:1001" }], unresolved), "ok");
});

test("taint only joins and never truncates: every kind, 256 sources inline and a count of the rest", () => {
  const product = { source: "product", sourceId: "product:1001" };
  const result = { source: "teammate_result", sourceId: "run_call_fake_1" };
  const tainted = (...sources) => taintFrom(sources);
  assert.deepEqual(cleanTaint(), {
    contextTaint: "none",
    kinds: [],
    sources: [],
    omittedSources: 0,
  });
  assert.deepEqual(taintFrom([]), cleanTaint());
  assert.deepEqual(joinRunTaint(cleanTaint(), cleanTaint()), cleanTaint());
  assert.deepEqual(joinRunTaint(cleanTaint(), tainted(product)), tainted(product));
  assert.deepEqual(joinRunTaint(tainted(product), cleanTaint()), tainted(product));
  assert.deepEqual(joinRunTaint(tainted(result), tainted(product, result), tainted(product)), {
    contextTaint: "untrusted_external",
    kinds: ["teammate_result", "product"],
    sources: [result, product],
    omittedSources: 0,
  });
  // A null source id is its own source, distinct from any id.
  assert.deepEqual(
    joinRunTaint(tainted({ source: "upload", sourceId: null }), tainted(product)).sources,
    [{ source: "upload", sourceId: null }, product],
  );
  // 256 sources inline; the rest counted, and a kind seen only past 256 is still listed.
  const many = Array.from({ length: 300 }, (_, i) => ({ source: "product", sourceId: `p:${i}` }));
  const memory = { source: "notebook_entry", sourceId: "entry_9" };
  const joinedTaint = joinRunTaint(
    tainted(...many.slice(0, 200)),
    tainted(...many.slice(200), memory),
  );
  assert.equal(joinedTaint.sources.length, runTaintSourceLimit);
  assert.equal(runTaintSourceLimit, 256);
  assert.deepEqual(joinedTaint.sources, many.slice(0, 256));
  assert.equal(joinedTaint.omittedSources, 45);
  assert.deepEqual(joinedTaint.kinds, ["product", "notebook_entry"]);
  assert.ok(runTaintValid(joinedTaint));
  // Counts add up through further joins: never fewer than there are.
  assert.equal(joinRunTaint(joinedTaint, joinedTaint).omittedSources, 90);
  assert.equal(runTaintValid({ ...tainted(product), kinds: ["upload"] }), false);
  assert.equal(runTaintValid({ ...tainted(product), omittedSources: -1 }), false);
});

test("read tags only join: distinct, in order of first appearance, refused rather than cut past 24", () => {
  assert.deepEqual(joinReadTags(), []);
  assert.deepEqual(joinReadTags([productTag, knowledgeTag], [], [knowledgeTag, ordersTag]), [
    productTag,
    knowledgeTag,
    ordersTag,
  ]);
  // A store-less tag is its own tag, distinct from the same capability on a store.
  const storeKnowledge = { storeId: fakeIds.storeId, capability: "workspace.knowledge.read" };
  assert.deepEqual(joinReadTags([knowledgeTag], [storeKnowledge]), [knowledgeTag, storeKnowledge]);
  const stores = (n) =>
    Array.from({ length: n }, (_, i) => ({ storeId: `store_${i}`, capability: "orders.read" }));
  assert.equal(readTagLimit, 24);
  assert.equal(joinReadTags(stores(20), stores(24)).length, 24);
  assert.equal(joinReadTags(stores(24), [productTag]), null);
  assert.ok(validateCurrentDefinition("ReadTags", joinReadTags(stores(24))));
});

// --- The fakes' conformance ------------------------------------------------------------------
const world = (options = {}) => {
  let clock = 0;
  const now = () => new Date(Date.parse(at) + clock++ * 1000).toISOString();
  const store = createFakeResultItemStore({
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    now,
  });
  const received = [];
  const scripted = (installationId, respond) => ({
    installationId,
    active: true,
    respond: (brief, tools) => {
      received.push(brief);
      return respond(brief, tools);
    },
  });
  const listings = scripted(fakeIds.listingsInstallationId, (brief) => ({
    completion: complete((c) => {
      if (brief.objective.length > teammateResultMaxBytes) c.result.summary = brief.objective;
    }),
    endReason: "completed",
    readTags: [productTag],
    taint: structuredClone(fakeTaint()),
    created: [{ kind: "proposal", id: "proposal_fake_1" }],
  }));
  const support = scripted(fakeIds.supportInstallationId, (brief) => ({
    completion: complete((c) => (c.result.summary = brief.objective)),
    endReason: "completed",
    readTags: [customerTag],
    taint: structuredClone(fakeTaint()),
    created: [],
  }));
  const paused = { ...scripted(fakeIds.inventoryInstallationId, listings.respond), active: false };
  // A teammate whose own run reads nothing untrusted.
  const clean = scripted("inst_clean", (brief) => ({
    completion: complete((c) => (c.result.summary = brief.objective)),
    endReason: "completed",
    readTags: [knowledgeTag],
    taint: cleanTaint(),
    created: [],
  }));
  // A teammate stopped mid-way after creating a task.
  const stopper = scripted("inst_stopper", () => ({
    completion: null,
    endReason: "stopped",
    readTags: [productTag],
    taint: cleanTaint(),
    created: [{ kind: "task", id: "task_made_1" }],
  }));
  // A teammate whose proposal's apply came back unknown.
  // A teammate whose run waits until the test lets it finish (a running child).
  let finishSlow = () => {};
  const slow = scripted("inst_slow", async () => {
    await new Promise((resolve) => (finishSlow = resolve));
    return {
      completion: complete(),
      endReason: "completed",
      readTags: [productTag],
      taint: cleanTaint(),
      created: [{ kind: "proposal", id: "proposal_fake_1" }],
    };
  });
  const unsure = scripted("inst_unsure", () => ({
    completion: complete((c) => (c.outcome = "partial")),
    endReason: "completed",
    readTags: [productTag],
    taint: cleanTaint(),
    created: [{ kind: "proposal", id: "proposal_fake_1" }],
    unresolved: [
      {
        subject: { kind: "product", id: "product:1001" },
        operation: { kind: "gateway_operation", id: "op_unknown_1" },
      },
    ],
  }));
  // A teammate that builds its result items with result.write.
  const writes = [];
  const writer = scripted("inst_writer", async (brief, { resultWrite }) => {
    const write = async (input) => {
      const outcome = await resultWrite({
        itemId: null,
        title: null,
        kind: null,
        mediaType: null,
        columns: null,
        text: null,
        rows: null,
        close: false,
        ...input,
      });
      writes.push(outcome);
      return outcome;
    };
    const table = await write({
      title: "Proposed titles",
      kind: "table",
      mediaType: "text/csv",
      columns: ["Product", "Proposed title"],
      rows: [["product:1001", "Linen summer dress"]],
    });
    const rows = Array.from({ length: 900 }, (_, i) => ["product:" + (2000 + i), "Dress " + i]);
    await write({ itemId: table.itemId, rows });
    await write({ itemId: table.itemId, text: "text into a table" });
    await write({ itemId: table.itemId, rows: [["a row one cell short"]] });
    await write({ itemId: table.itemId, close: true });
    await write({ itemId: table.itemId, rows: [["late", "row"]] });
    const notes = await write({
      title: "Notes",
      kind: "text",
      mediaType: "text/markdown",
      text: "# Notes\n",
    });
    await write({ itemId: notes.itemId, text: "Left open; code closes it at the end." });
    await write({ itemId: "item_someone_elses", text: "x" });
    await write({ title: "Bad", kind: "table", mediaType: "text/plain", columns: ["A"] });
    return {
      completion: complete((c) => {
        c.criteria = [
          { index: 0, status: "met", evidence: [{ kind: "result_item", id: table.itemId }] },
          { index: 1, status: "not_met", evidence: [] },
        ];
        c.result.items = [table.itemId];
      }),
      endReason: "completed",
      readTags: [productTag],
      taint: structuredClone(fakeTaint()),
      created: [],
    };
  });
  // A teammate that reads products and orders on its first sequence; a follow-up reads nothing
  // new and writes an item, unless its brief asks it to read the support case.
  const reader = scripted("inst_reader", async (brief, { resultWrite }) => {
    const first = brief.followUpOf === null;
    const support = brief.objective === "Read the support case.";
    if (!first)
      await resultWrite({
        itemId: null,
        title: "As before",
        kind: "text",
        mediaType: "text/markdown",
        columns: null,
        text: "The same answer, from what I read before.",
        rows: null,
        close: false,
      });
    return {
      completion: complete(),
      endReason: "completed",
      readTags: first ? [productTag, ordersTag] : support ? [customerTag] : [],
      taint: cleanTaint(),
      created: [],
    };
  });
  let balance = options.balance ?? Infinity;
  const runner = createFakeTeammateRunner({
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    teammates: [listings, support, paused, clean, stopper, unsure, writer, slow, reader],
    store,
    coversCall: () => balance-- > 0,
    now,
  });
  return { store, runner, received, writes, finish: () => finishSlow() };
};
let nextToolUse = 1;
const ask = (runner, change = {}) => {
  const { installationId, mode, followUpOf, brief, ...rest } = change;
  return runner.call({
    parentRunId: fakeIds.runId,
    callerTaint: cleanTaint(),
    toolUseId: "toolu_" + nextToolUse++,
    request: fakeTeammateBrief().request,
    input: {
      installationId:
        installationId === undefined ? fakeIds.listingsInstallationId : installationId,
      mode: mode ?? "ask",
      followUpOf: followUpOf ?? null,
      brief: brief ?? fakeTeammateBriefInput(),
    },
    ...rest,
  });
};

test("the fake runner returns TeammateResult@1 Morrow may take in, each fresh call a fresh child", async () => {
  const { runner, received } = world();
  const first = await ask(runner);
  const second = await ask(runner);
  assert.equal(first.ok && second.ok, true);
  for (const { result, callId, sequence } of [first, second]) {
    assert.ok(validateCurrentDefinition("TeammateResult", result));
    assert.equal(acceptTeammateResult(result), "ok");
    assert.equal(result.parentRunId, fakeIds.runId);
    assert.equal(result.callId, callId);
    assert.equal(sequence, 1);
    assert.deepEqual(
      result.criteria.map((c) => c.status),
      ["met", "met"],
    );
  }
  assert.notEqual(first.callId, second.callId);
  assert.notEqual(
    first.result.runId,
    second.result.runId,
    "the same teammate again is a new child",
  );
  assert.equal(runner.children(fakeIds.runId), 2);
  // The teammate received the brief code built: the requester's words, the mode, no follow-up.
  assert.deepEqual(received[0], fakeTeammateBrief());
});

test("parallel calls are admitted alone and each returns its own result", async () => {
  const { runner } = world();
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) => ask(runner, { toolUseId: "toolu_parallel_" + i })),
  );
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(
    results.map((r) => r.result.toolUseId),
    ["toolu_parallel_0", "toolu_parallel_1", "toolu_parallel_2", "toolu_parallel_3"],
  );
  assert.equal(new Set(results.map((r) => r.result.runId)).size, 4);
});

test("refusals and waits: a paused or unknown teammate, a bad input, the customer tag; the 33rd child checks in and the balance parks", async () => {
  const { runner } = world({ balance: maximumChildrenPerEnvelope + 5 });
  assert.deepEqual(await ask(runner, { installationId: fakeIds.inventoryInstallationId }), {
    ok: false,
    refusal: "teammate_unavailable",
  });
  assert.deepEqual(await ask(runner, { installationId: "inst_unknown" }), {
    ok: false,
    refusal: "teammate_unavailable",
  });
  assert.deepEqual(await ask(runner, { brief: "do it" }), { ok: false, refusal: "input_invalid" });
  assert.deepEqual(
    await ask(runner, { brief: { ...fakeTeammateBriefInput(), doneCriteria: [] } }),
    {
      ok: false,
      refusal: "input_invalid",
    },
  );
  assert.deepEqual(await ask(runner, { request: { text: "no message id" } }), {
    ok: false,
    refusal: "input_invalid",
  });
  for (const callerTaint of [
    undefined,
    { contextTaint: "untrusted_external", kinds: [], sources: [], omittedSources: 0 },
    {
      contextTaint: "none",
      kinds: [],
      sources: [{ source: "product", sourceId: null }],
      omittedSources: 0,
    },
    { ...fakeTaint(), kinds: ["upload"] },
  ])
    assert.deepEqual(await ask(runner, { callerTaint }), { ok: false, refusal: "input_invalid" });
  assert.deepEqual(await ask(runner, { installationId: fakeIds.supportInstallationId }), {
    ok: false,
    refusal: "result_customer_tagged",
  });
  while (runner.children(fakeIds.runId) < maximumChildrenPerEnvelope)
    assert.ok((await ask(runner)).ok);
  // ADR-0041 item 21: at 32 the job checks in; nothing is admitted and nothing is refused.
  assert.deepEqual(await ask(runner), { ok: false, wait: "children_checkin" });
  assert.equal(runner.children(fakeIds.runId), maximumChildrenPerEnvelope);
  // Another Morrow run has its own envelope.
  assert.ok((await ask(runner, { parentRunId: "run_fake_2" })).ok);
  // The balance: a call it cannot cover admits nothing, and the job parks on credits.
  const poor = world({ balance: 0 }).runner;
  assert.deepEqual(await ask(poor), { ok: false, wait: "credits" });
  assert.equal(poor.children(fakeIds.runId), 0);
  assert.equal(maximumChildrenPerEnvelope, 32);
});

test("cancelling a running child stops it: what it did is kept as partial, and it is released", async () => {
  const { runner, finish } = world();
  const pending = ask(runner, { installationId: "inst_slow" });
  // The child is admitted and running; its call id is the runner's first.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runner.cancel(fakeIds.runId, "call_fake_1"), { ok: true, state: "cancelled" });
  finish();
  const stopped = await pending;
  assert.ok(stopped.ok);
  assert.equal(stopped.result.endReason, "stopped");
  assert.equal(stopped.result.outcome, "partial", "a completion that a stop overtook is kept");
  assert.deepEqual(stopped.result.created, fakeTeammateResult().created);
  assert.deepEqual(runner.cancel(fakeIds.runId, stopped.callId), {
    ok: false,
    refusal: "call_not_idle",
  });
  assert.deepEqual(await ask(runner, { installationId: null, followUpOf: stopped.callId }), {
    ok: false,
    refusal: "call_not_idle",
  });
});

test("follow-ups reopen an idle child with the next sequence; cancel releases it", async () => {
  const { runner, received } = world();
  const first = await ask(runner);
  assert.ok(first.ok);
  const brief = { ...fakeTeammateBriefInput(), objective: "Now the autumn dresses.", records: [] };
  const followUp = await ask(runner, { installationId: null, followUpOf: first.callId, brief });
  assert.ok(followUp.ok);
  assert.equal(followUp.callId, first.callId);
  assert.equal(followUp.sequence, 2);
  assert.equal(followUp.result.sequence, 2);
  assert.equal(followUp.result.runId, first.result.runId, "the same child keeps its context");
  assert.equal(runner.children(fakeIds.runId), 1, "a follow-up is no new child");
  assert.equal(received.at(-1).followUpOf, first.callId);
  // What the first brief gave stays given: evidence citing it still resolves.
  assert.deepEqual(
    followUp.result.criteria.map((c) => c.status),
    ["met", "met"],
  );
  // A follow-up names a call of this run, idle, and no teammate.
  assert.deepEqual(await ask(runner, { installationId: null, followUpOf: "call_none" }), {
    ok: false,
    refusal: "call_not_found",
  });
  assert.deepEqual(
    await ask(runner, { installationId: null, followUpOf: first.callId, parentRunId: "run_b" }),
    { ok: false, refusal: "call_not_found" },
  );
  assert.deepEqual(await ask(runner, { followUpOf: first.callId }), {
    ok: false,
    refusal: "input_invalid",
  });
  assert.deepEqual(runner.cancel("run_b", first.callId), { ok: false, refusal: "call_not_found" });
  assert.deepEqual(runner.cancel(fakeIds.runId, first.callId), { ok: true, state: "released" });
  assert.deepEqual(runner.cancel(fakeIds.runId, first.callId), {
    ok: false,
    refusal: "call_not_idle",
  });
  assert.deepEqual(await ask(runner, { installationId: null, followUpOf: first.callId }), {
    ok: false,
    refusal: "call_not_idle",
  });
  assert.deepEqual(runner.cancel(fakeIds.runId, "call_none"), {
    ok: false,
    refusal: "call_not_found",
  });
});

test("a stopped child keeps its work as partial; unknown outcomes block a retry over their subjects", async () => {
  const { runner } = world();
  const stopped = await ask(runner, { installationId: "inst_stopper" });
  assert.ok(stopped.ok);
  assert.equal(stopped.result.outcome, "partial");
  assert.deepEqual(stopped.result.created, {
    kind: "list",
    records: [{ kind: "task", id: "task_made_1" }],
  });
  assert.equal(stopped.result.next, "follow_up");
  const unsure = await ask(runner, { installationId: "inst_unsure" });
  assert.ok(unsure.ok);
  assert.equal(unsure.result.next, "do_not_retry");
  assert.equal(unsure.result.unresolved.subjects.length, 1);
  // The default brief names product:1001: refused until the reconciler settles it.
  assert.deepEqual(await ask(runner), { ok: false, refusal: "retry_blocked" });
  const other = { ...fakeTeammateBriefInput(), records: [{ kind: "product", id: "product:2002" }] };
  assert.ok((await ask(runner, { brief: other })).ok);
  // Another Morrow run's unknown outcomes are its own.
  assert.ok((await ask(runner, { parentRunId: "run_fake_3" })).ok);
});

test("review H5-1: read tags only join across a child's sequences; a follow-up never narrows them", async () => {
  const { runner, store } = world();
  const first = await ask(runner, { installationId: "inst_reader" });
  assert.ok(first.ok);
  // The requester's words' tag, then what the run read.
  assert.deepEqual(first.result.readTags, [knowledgeTag, productTag, ordersTag]);
  // The follow-up reads nothing new and carries no request, yet its context still holds what
  // the first sequence read: its result and the item it writes keep every tag.
  const followUp = await ask(runner, {
    installationId: null,
    followUpOf: first.callId,
    request: null,
    brief: { ...fakeTeammateBriefInput(), objective: "Say it again.", records: [] },
  });
  assert.ok(followUp.ok);
  assert.equal(followUp.result.runId, first.result.runId);
  assert.equal(followUp.sequence, 2);
  for (const tag of first.result.readTags)
    assert.ok(
      followUp.result.readTags.some(
        (t) => t.storeId === tag.storeId && t.capability === tag.capability,
      ),
      tag.capability,
    );
  assert.deepEqual(followUp.result.readTags, first.result.readTags);
  assert.equal(followUp.result.items.length, 1);
  assert.deepEqual(store.item(followUp.result.items[0].itemId).readTags, first.result.readTags);
});

test("review H5-1: a customer-tagged result releases its child, so no follow-up returns what it read", async () => {
  const { runner } = world();
  // A first sequence that read the support case: refused, and its child (call_fake_1) released.
  assert.deepEqual(await ask(runner, { installationId: fakeIds.supportInstallationId }), {
    ok: false,
    refusal: "result_customer_tagged",
  });
  const again = { ...fakeTeammateBriefInput(), objective: "As before, briefly.", records: [] };
  assert.deepEqual(
    await ask(runner, { installationId: null, followUpOf: "call_fake_1", brief: again }),
    { ok: false, refusal: "call_not_idle" },
  );
  assert.deepEqual(runner.cancel(fakeIds.runId, "call_fake_1"), {
    ok: false,
    refusal: "call_not_idle",
  });
  assert.equal(runner.children(fakeIds.runId), 1, "the refused call still counted");
  // A follow-up that reads the support case is refused the same way, and its child released.
  const reader = await ask(runner, { installationId: "inst_reader" });
  assert.ok(reader.ok);
  const support = { ...again, objective: "Read the support case." };
  assert.deepEqual(
    await ask(runner, { installationId: null, followUpOf: reader.callId, brief: support }),
    { ok: false, refusal: "result_customer_tagged" },
  );
  assert.deepEqual(
    await ask(runner, { installationId: null, followUpOf: reader.callId, brief: again }),
    { ok: false, refusal: "call_not_idle" },
  );
});

test("review H5-4: a follow-up keeps the child's subjects, so retry_blocked holds until the reconciler settles them", async () => {
  const { runner } = world();
  const product = { kind: "product", id: "product:1001" };
  const again = { ...fakeTeammateBriefInput(), objective: "Try that again.", records: [] };
  // The child was given product:1001 and left it unknown: a follow-up naming no records is
  // still over it.
  const given = await ask(runner, { installationId: "inst_unsure" });
  assert.ok(given.ok);
  assert.equal(given.result.next, "do_not_retry");
  assert.deepEqual(
    await ask(runner, { installationId: null, followUpOf: given.callId, brief: again }),
    { ok: false, refusal: "retry_blocked" },
  );
  // A subject the child left unknown without being given it holds the same way.
  const elsewhere = "run_fake_4";
  const other = { ...fakeTeammateBriefInput(), records: [{ kind: "product", id: "product:2002" }] };
  const left = await ask(runner, {
    installationId: "inst_unsure",
    parentRunId: elsewhere,
    brief: other,
  });
  assert.ok(left.ok);
  const followLeft = () =>
    ask(runner, {
      installationId: null,
      followUpOf: left.callId,
      parentRunId: elsewhere,
      brief: again,
    });
  assert.deepEqual(await followLeft(), { ok: false, refusal: "retry_blocked" });
  // Once the reconciler settles the subject, the follow-up is admitted; another run's
  // settlement is its own.
  runner.settle(elsewhere, product);
  const settled = await followLeft();
  assert.ok(settled.ok);
  assert.equal(settled.sequence, 2);
  assert.deepEqual(
    await ask(runner, { installationId: null, followUpOf: given.callId, brief: again }),
    { ok: false, refusal: "retry_blocked" },
  );
  runner.settle(fakeIds.runId, product);
  assert.ok(
    (await ask(runner, { installationId: null, followUpOf: given.callId, brief: again })).ok,
  );
  // A fresh call over it is admitted again too.
  runner.settle(fakeIds.runId, product);
  assert.ok((await ask(runner)).ok);
});

test("result.write builds a called teammate's items across turns: its own items only, never after close", async () => {
  const { runner, store, writes } = world();
  const call = await ask(runner, { installationId: "inst_writer" });
  assert.ok(call.ok);
  const [start, append, wrongKind, narrow, close, late, notes, notesAppend, foreign, bad] = writes;
  assert.deepEqual([start.ok, append.ok, close.ok], [true, true, true]);
  assert.deepEqual([start.open, append.open, close.open], [true, true, false]);
  assert.deepEqual([start.sections, append.sections, close.sections], [1, 2, 2]);
  assert.deepEqual(late, { ok: false, outcome: "refused", refusal: "item_closed" });
  assert.deepEqual(wrongKind, { ok: false, outcome: "invalid_input", refusal: "input_invalid" });
  assert.deepEqual(narrow, wrongKind, "one cell per column, checked against the stored columns");
  assert.ok(notes.ok && notesAppend.ok && notesAppend.open);
  assert.deepEqual(foreign, { ok: false, outcome: "refused", refusal: "item_not_received" });
  assert.deepEqual(bad, { ok: false, outcome: "invalid_input", refusal: "input_invalid" });
  // The result lists every item the child wrote; the open one closed when the run ended.
  assert.deepEqual(
    call.result.items.map((i) => i.itemId),
    [start.itemId, notes.itemId],
  );
  const table = store.item(start.itemId);
  assert.ok(validateCurrentDefinition("ResultItem", table));
  assert.equal(table.open, false);
  assert.equal(store.item(notes.itemId).open, false);
  // The items carry the run's read tags (the requester's words' and its own reads') and taint,
  // as code stamps them.
  assert.deepEqual(table.readTags, [knowledgeTag, productTag]);
  assert.deepEqual(table.taint, fakeTaint());
  // Evidence citing a written item resolves; Morrow reads the table back row for row.
  assert.deepEqual(
    call.result.criteria.map((c) => c.status),
    ["met", "not_met"],
  );
  const rows = [];
  for (let page = 1; page <= table.pageCount; page++) {
    const read = store.readForCoordinator({ runId: fakeIds.runId, itemId: start.itemId, page });
    assert.ok(read.ok);
    assert.equal(read.page.content.firstRow, rows.length + 1);
    rows.push(...read.page.content.rows);
  }
  assert.equal(rows.length, 901);
  assert.deepEqual(rows[0], ["product:1001", "Linen summer dress"]);
  const text = store.readForCoordinator({ runId: fakeIds.runId, itemId: notes.itemId, page: 1 });
  assert.equal(text.page.content.text, "# Notes\nLeft open; code closes it at the end.");
});

test("the fake store: items read page by page by the run that received them, refused to others", async () => {
  const { store, runner } = world();
  const brief = { ...fakeTeammateBriefInput(), objective: huge("Long brief. ") };
  const call = await ask(runner, { brief });
  assert.ok(call.ok);
  assert.equal(call.result.summary.kind, "item");
  const itemId = call.result.summary.itemId;
  const record = store.item(itemId);
  assert.ok(validateCurrentDefinition("ResultItem", record));
  assert.equal(record.runId, call.result.runId);
  assert.equal(record.open, false);
  assert.deepEqual(record.readTags, [knowledgeTag, productTag]);
  assert.deepEqual(record.taint, fakeTaint());
  const pages = [];
  for (let page = 1; page <= record.pageCount; page++) {
    const read = store.readForCoordinator({ runId: fakeIds.runId, itemId, page });
    assert.ok(read.ok);
    pages.push(read.page.content.text);
  }
  assert.equal(joined(pages), brief.objective);
  assert.deepEqual(
    store.readForCoordinator({ runId: fakeIds.runId, itemId, page: record.pageCount + 1 }),
    { ok: false, refusal: "page_out_of_range" },
  );
  // Another Morrow run, or an id that does not exist, reads as not received.
  assert.deepEqual(store.readForCoordinator({ runId: "run_other", itemId, page: 1 }), {
    ok: false,
    refusal: "item_not_received",
  });
  assert.deepEqual(
    store.readForCoordinator({ runId: fakeIds.runId, itemId: "item_none", page: 1 }),
    { ok: false, refusal: "item_not_received" },
  );
  // A teammate opens it only when its brief names it and its calling run received it.
  const named = { ...fakeTeammateBrief(), records: [{ kind: "result_item", id: itemId }] };
  assert.ok(
    store.readForTeammate({ callingRunId: fakeIds.runId, brief: named, itemId, page: 1 }).ok,
  );
  assert.deepEqual(
    store.readForTeammate({
      callingRunId: fakeIds.runId,
      brief: fakeTeammateBrief(),
      itemId,
      page: 1,
    }),
    { ok: false, refusal: "item_not_received" },
  );
  assert.deepEqual(
    store.readForTeammate({
      callingRunId: "run_another_persons_ask",
      brief: named,
      itemId,
      page: 1,
    }),
    { ok: false, refusal: "item_not_received" },
  );
  // A customer-tagged result's items are stored but never openable by Morrow.
  const before = store.size;
  await ask(runner, { installationId: fakeIds.supportInstallationId, brief });
  assert.ok(store.size > before);
  const supportItem = `item_fake_${store.size}`;
  assert.deepEqual(
    store.readForCoordinator({ runId: fakeIds.runId, itemId: supportItem, page: 1 }),
    { ok: false, refusal: "item_not_received" },
  );
});

test("review F4: a tainted Morrow run's call starts tainted; its items and result carry the taint", async () => {
  const { store, runner } = world();
  const callerTaint = taintFrom([{ source: "teammate_result", sourceId: "run_call_earlier" }]);
  // The called teammate reads nothing untrusted, yet its result carries its caller's taint.
  const brief = { ...fakeTeammateBriefInput(), objective: huge("Long brief. ") };
  const clean = await ask(runner, { installationId: "inst_clean", callerTaint, brief });
  assert.ok(clean.ok);
  assert.deepEqual(clean.result.taint, callerTaint);
  assert.ok(clean.result.items.length > 0);
  for (const item of clean.result.items)
    assert.deepEqual(store.item(item.itemId).taint, callerTaint);
  // An untainted caller's call to the same teammate stays untainted.
  const plain = await ask(runner, { installationId: "inst_clean" });
  assert.deepEqual(plain.result.taint, cleanTaint());
  // Both taints join when the teammate's own run reads untrusted content too.
  const both = await ask(runner, { callerTaint });
  assert.deepEqual(both.result.taint, {
    contextTaint: "untrusted_external",
    kinds: ["teammate_result", "product"],
    sources: [...callerTaint.sources, ...fakeTaint().sources],
    omittedSources: 0,
  });
  // A follow-up keeps what the child read before, even from an untainted caller.
  const followUp = await ask(runner, {
    installationId: null,
    followUpOf: both.callId,
    brief: { ...fakeTeammateBriefInput(), records: [] },
  });
  assert.deepEqual(followUp.result.taint, both.result.taint);
});
