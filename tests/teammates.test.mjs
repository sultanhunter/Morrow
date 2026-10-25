// ADR-0037 PR 2 (docs/briefs/adr-0037-contracts.md): teammate calls' results in code and the
// conformance of their deterministic fakes (item 3(a)). TeammateResult@1 has no character cap:
// what does not fit one 8 KiB tool result is stored whole as a result item and read page by
// page, so joining the pages gives back exactly what the teammate wrote. Morrow opens only
// items of results its own run received; a teammate only those named in its brief that its
// calling run received; nothing customer-tagged reaches Morrow; each call is admitted alone
// under the kernel's 32 children and the balance (credits only, no money cap).
import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptTeammateResult,
  buildTeammateResult,
  codeOutcome,
  coordinatorMayOpen,
  csvText,
  receivedItemIds,
  resultItemPage,
  resultItemPageBytes,
  resultSubmitValid,
  tableItemDraft,
  tablePages,
  teammateMayOpen,
  teammateResultValid,
  teamSwitchState,
  textItemDraft,
  textPages,
  toolResultMaxBytes,
} from "../packages/policy/src/teammates.ts";
import {
  createFakeResultItemStore,
  createFakeTeammateRunner,
  maximumChildrenPerEnvelope,
} from "../packages/policy/src/teammate-fakes.ts";
import {
  fakeIds,
  fakeResultSubmit,
  fakeTaint,
  fakeTeammateBrief,
  fakeTeammateResult,
} from "../packages/policy/src/agent-platform-fakes.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

const at = "2026-10-26T09:03:00.000Z";
const productTag = { storeId: fakeIds.storeId, capability: "catalog.products.read" };
const customerTag = { storeId: fakeIds.storeId, capability: "support.case.read" };
const facts = (change = () => {}) => {
  const f = {
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    parentRunId: fakeIds.runId,
    toolUseId: fakeIds.toolUseId,
    runId: fakeIds.callRunId,
    taskId: fakeIds.callTaskId,
    installationId: fakeIds.listingsInstallationId,
    endReason: "completed",
    created: [{ kind: "proposal", id: "proposal_fake_1" }],
    readTags: [productTag, { storeId: null, capability: "workspace.knowledge.read" }],
    taint: structuredClone(fakeTaint()),
    completedAt: at,
  };
  change(f);
  return f;
};
const submit = (change = () => {}) => {
  const s = structuredClone(fakeResultSubmit());
  change(s);
  return s;
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

test("the team switches are committed off", () => {
  assert.deepEqual(teamSwitchState(), { teammateCalls: "off", agentCards: "off" });
});

test("a result that fits is the fake, everything inline; no item is stored", async () => {
  const { stored, sink } = memorySink();
  const result = await buildTeammateResult(facts(), submit(), sink);
  assert.deepEqual(result, fakeTeammateResult());
  assert.equal(stored.length, 0);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.findings[0]));
  assert.equal(acceptTeammateResult(result), "ok");
});

test("nothing is cut: a long summary becomes an item, read back page by page exactly", async () => {
  const long = 'Ünïcode 🌿 and "quotes" and a\tcontrol.\n'.repeat(900);
  const { stored, sink } = memorySink();
  const result = await buildTeammateResult(
    facts(),
    submit((s) => (s.summary = long)),
    sink,
  );
  assert.ok(bytes(result) <= toolResultMaxBytes);
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
  const pages = [];
  for (let page = 1; page <= stored[0].pageCount; page++) {
    const p = resultItemPage(
      { itemId: "item_mem_1", kind: "text", title: "Summary", content: stored[0].content },
      page,
    );
    assert.ok(validateCurrentDefinition("ResultItemPage", p));
    assert.ok(bytes(p) <= toolResultMaxBytes, "a page fits one tool result");
    pages.push(p.content.text);
  }
  assert.equal(joined(pages), long);
  assert.equal(
    resultItemPage(
      { itemId: "x", kind: "text", title: "S", content: stored[0].content },
      stored[0].pageCount + 1,
    ),
    "page_out_of_range",
  );
  assert.equal(
    resultItemPage({ itemId: "x", kind: "text", title: "S", content: stored[0].content }, 0),
    "page_out_of_range",
  );
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
  const rows = Array.from({ length: 600 }, (_, i) => ["product:" + (1000 + i), "Linen dress " + i]);
  const { stored, sink } = memorySink();
  const result = await buildTeammateResult(
    facts(),
    submit((s) => (s.findings[1].table.rows = rows)),
    sink,
  );
  assert.ok(teammateResultValid(result));
  const tableFinding = result.findings[1];
  assert.equal(tableFinding.table.kind, "item");
  const draft = stored.find((d) => d.kind === "table");
  assert.ok(draft.pageCount > 1);
  const back = [];
  for (let page = 1; page <= draft.pageCount; page++) {
    const p = resultItemPage(
      {
        itemId: tableFinding.table.itemId,
        kind: "table",
        title: draft.title,
        content: draft.content,
      },
      page,
    );
    assert.ok(validateCurrentDefinition("ResultItemPage", p));
    assert.ok(bytes(p) <= toolResultMaxBytes);
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

test("many findings: they move whole into one JSON item when moving parts is not enough", async () => {
  const findings = Array.from({ length: 200 }, (_, i) => ({
    kind: "fact",
    title: "Finding number " + i + " about a product title that is long enough to matter",
    detail: "",
    records: [{ kind: "product", id: "product:" + (1000 + i) }],
    value: null,
    unit: null,
    table: null,
  }));
  const { stored, sink } = memorySink();
  const result = await buildTeammateResult(
    facts(),
    submit((s) => (s.findings = findings)),
    sink,
  );
  assert.ok(bytes(result) <= toolResultMaxBytes);
  assert.deepEqual(result.findings, []);
  assert.equal(result.items.length, stored.length);
  const all = stored.find((d) => d.mediaType === "application/json");
  assert.deepEqual(JSON.parse(all.content.text), findings);
  assert.equal(all.title, "Findings (200)");
});

test("the same input stores the same items in the same order", async () => {
  const input = submit((s) => {
    s.summary = "S".repeat(9000);
    s.findings[1].detail = "D".repeat(9000);
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

test("code sets the outcome when the run ends without result.submit; model text never does", async () => {
  for (const [endReason, outcome] of [
    ["turn_limit", "no_result"],
    ["wall_time", "no_result"],
    ["completed", "no_result"],
    ["stopped", "stopped"],
    ["lease_ended", "stopped"],
    ["provider_error", "failed"],
    ["invalid_output", "failed"],
  ]) {
    assert.equal(codeOutcome(endReason), outcome, endReason);
    const result = await buildTeammateResult(
      facts((f) => (f.endReason = endReason)),
      null,
      memorySink().sink,
    );
    assert.equal(result.outcome, outcome);
    assert.equal(result.summary, null);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.created, facts().created, "the records it created stay listed");
  }
  // result.submit only completes a run; a stopped run's submit is refused.
  await assert.rejects(
    buildTeammateResult(
      facts((f) => (f.endReason = "stopped")),
      submit(),
      memorySink().sink,
    ),
    /TEAMMATE_RESULT_INPUT_INVALID/,
  );
});

test("result.submit's code rules: metric values, table findings and row widths", () => {
  assert.ok(resultSubmitValid(fakeResultSubmit()));
  for (const change of [
    (s) => (s.findings[1].value = 3),
    (s) => (s.findings[0].table = { columns: ["A"], rows: [] }),
    (s) => (s.findings[1].table = null),
    (s) => s.findings[1].table.rows.push(["only one cell"]),
    (s) => (s.outcome = "stopped"),
    (s) => (s.capabilities = []),
  ])
    assert.equal(resultSubmitValid(submit(change)), false);
});

test("TeammateResult@1's code rules: listed items, named items, and the customer tag refused", () => {
  const result = structuredClone(fakeTeammateResult());
  assert.ok(teammateResultValid(result));
  const named = structuredClone(result);
  named.summary = { kind: "item", itemId: "item_unlisted" };
  assert.equal(teammateResultValid(named), false, "a named item must be listed");
  const twice = structuredClone(result);
  const ref = { itemId: "item_1", kind: "text", title: "T", sizeBytes: 1, pageCount: 1 };
  twice.items = [ref, ref];
  assert.equal(teammateResultValid(twice), false);
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

// --- The fakes' conformance ------------------------------------------------------------------
const world = (options = {}) => {
  let clock = 0;
  const now = () => new Date(Date.parse(at) + clock++ * 1000).toISOString();
  const store = createFakeResultItemStore({
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    now,
  });
  const scripted = (installationId, respond) => ({ installationId, active: true, respond });
  const listings = scripted(fakeIds.listingsInstallationId, (brief) => ({
    submit: submit(
      (s) => (s.summary = brief.objective.length > 8000 ? brief.objective : s.summary),
    ),
    endReason: "completed",
    readTags: [productTag],
    taint: structuredClone(fakeTaint()),
    created: [],
  }));
  const support = scripted(fakeIds.supportInstallationId, (brief) => ({
    submit: submit((s) => (s.summary = brief.objective)),
    endReason: "completed",
    readTags: [customerTag],
    taint: structuredClone(fakeTaint()),
    created: [],
  }));
  const paused = { ...scripted(fakeIds.inventoryInstallationId, listings.respond), active: false };
  let balance = options.balance ?? Infinity;
  const runner = createFakeTeammateRunner({
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    teammates: [listings, support, paused],
    store,
    coversCall: () => balance-- > 0,
    now,
  });
  return { store, runner };
};
let nextToolUse = 1;
const ask = (runner, change = {}) =>
  runner.call({
    parentRunId: fakeIds.runId,
    toolUseId: "toolu_" + nextToolUse++,
    installationId: fakeIds.listingsInstallationId,
    brief: fakeTeammateBrief(),
    ...change,
  });

test("the fake runner returns TeammateResult@1 Morrow may take in, each call a fresh run", async () => {
  const { runner } = world();
  const first = await ask(runner);
  const second = await ask(runner);
  assert.equal(first.ok && second.ok, true);
  for (const { result } of [first, second]) {
    assert.ok(validateCurrentDefinition("TeammateResult", result));
    assert.equal(acceptTeammateResult(result), "ok");
    assert.equal(result.parentRunId, fakeIds.runId);
  }
  assert.notEqual(first.result.runId, second.result.runId, "the same teammate again is a new run");
  assert.equal(runner.children(fakeIds.runId), 2);
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

test("refusals: a paused or unknown teammate, the 32-children bound, the balance, a bad brief, the customer tag", async () => {
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
  assert.deepEqual(await ask(runner, { installationId: fakeIds.supportInstallationId }), {
    ok: false,
    refusal: "result_customer_tagged",
  });
  while (runner.children(fakeIds.runId) < maximumChildrenPerEnvelope)
    assert.ok((await ask(runner)).ok);
  assert.deepEqual(await ask(runner), { ok: false, refusal: "children_limit" });
  // Another Morrow run has its own envelope.
  assert.ok((await ask(runner, { parentRunId: "run_fake_2" })).ok);
  // The balance: a call it cannot cover is refused at once, never queued.
  const poor = world({ balance: 0 }).runner;
  assert.deepEqual(await ask(poor), { ok: false, refusal: "insufficient_credits" });
  assert.equal(poor.children(fakeIds.runId), 0);
  assert.equal(maximumChildrenPerEnvelope, 32);
});

test("the fake store: items read page by page by the run that received them, refused to others", async () => {
  const { store, runner } = world();
  const brief = { ...fakeTeammateBrief(), objective: "Long brief. ".repeat(1200) };
  const call = await ask(runner, { brief });
  assert.ok(call.ok);
  assert.equal(call.result.summary.kind, "item");
  const itemId = call.result.summary.itemId;
  const record = store.item(itemId);
  assert.ok(validateCurrentDefinition("ResultItem", record));
  assert.equal(record.runId, call.result.runId);
  assert.deepEqual(record.readTags, [productTag]);
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
    {
      ok: false,
      refusal: "item_not_received",
    },
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
    {
      ok: false,
      refusal: "item_not_received",
    },
  );
});
