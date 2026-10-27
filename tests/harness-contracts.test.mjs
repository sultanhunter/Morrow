// Harness contracts with fakes (H6; docs/briefs/h6-harness-contracts.md): the ADR-0041
// contracts in the unfrozen v1.1 set (AgentRunSafety@1, ContextPolicy@1, ContextEpoch@1,
// ContextCheckpoint@1, ContextLedger@1, RunPlan@1, RunCompletion@1, ReviewVerdict@1, RunWait@1,
// RunEvent@1, ConversationSummary@1, PersonMemory@1, PersonMemorySuggestion@1, NotebookEntry@2,
// MemorySearchHit@1, the new message blocks and ModelResult@2's compaction) and ADR-0040's
// JobStatus@1; the harness rules in code (packages/policy/src/harness.ts); the context policy
// data, its generator's inspections and its thresholds (context-policy.ts); and the fake
// broker's conformance (fake-model-gateway.ts). Pure: the ahead-of-time validators only, no
// database, no Worker and no provider.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import * as platform from "../packages/policy/src/agent-platform-fakes.ts";
import * as fakes from "../packages/policy/src/harness-fakes.ts";
import * as harness from "../packages/policy/src/harness.ts";
import {
  activeContextPolicyRow,
  activeContextPolicyVersion,
  cacheTtls,
  contextPolicyRow,
  contextPolicyStatus,
  contextStep,
  contextThresholds,
} from "../packages/policy/src/context-policy.ts";
import { generatedContextPolicy } from "../packages/policy/src/generated/context-policy.ts";
import { runContext } from "../packages/policy/src/tool-catalogue.ts";
import {
  createFakeContextStore,
  createFakeModelGateway,
  FakeContextStoreError,
  FakeModelGatewayError,
  replyBounds,
  replyFit,
  replyStoredBytes,
} from "../packages/policy/src/fake-model-gateway.ts";
import {
  bytesPerTokenEstimate,
  contextPolicyDigest,
  generateContextPolicy,
  generatedContextPolicyPath,
  inspectContextPolicy,
  inspectContextPolicyRow,
  jcs,
  maxOutputTokensRange,
  toolResultBlockChars,
} from "../scripts/generate-context-policy.mjs";

const core = JSON.parse(readFileSync("docs/contracts/schemas/v1.1/core.schema.json", "utf8"));
const coreV1 = JSON.parse(readFileSync("docs/contracts/schemas/v1/core.schema.json", "utf8"));
// A definition's enum, through a local alias (one definition under two names, as the H5 merge
// leaves the records' names on H5's inputs).
const enumOf = (name) => {
  const definition = core.$defs[name] ?? coreV1.$defs[name];
  return definition.$ref ? enumOf(definition.$ref.replace("#/$defs/", "")) : definition.enum;
};
const valid = (name, value) => validateCurrentDefinition(name, value);
const edit = (value, change) => {
  const copy = structuredClone(value);
  change(copy);
  return copy;
};
const refuses = (name, cases) => {
  for (const [label, value] of cases) assert.equal(valid(name, value), false, label);
};
const digest = "a".repeat(64);
const day = 86_400_000;

test("every harness fake validates against its contract, frozen and synthetic", () => {
  const cases = [
    ["AgentRunParams", fakes.fakeAgentRunParams()],
    ["ModelCallV2", fakes.fakeModelCall()],
    ["ModelResultV2", fakes.fakeModelResult()],
    ["ContextSectionTokens", fakes.fakeSectionTokens()],
    ["ContextPolicy", fakes.fakeContextPolicy("high")],
    ["ContextPolicy", fakes.fakeContextPolicy("medium")],
    ["ContextEpoch", fakes.fakeContextEpoch("initial")],
    ["ContextEpoch", fakes.fakeContextEpoch("compaction")],
    ["ContextCheckpoint", fakes.fakeContextCheckpoint("fallback")],
    ["ContextCheckpoint", fakes.fakeContextCheckpoint("provider_compaction")],
    ["ContextLedger", fakes.fakeContextLedger()],
    ["RunPlan", fakes.fakeRunPlan(1)],
    ["RunPlan", fakes.fakeRunPlan(2)],
    ...["done", "waiting", "partial", "refused"].map((k) => [
      "RunCompletion",
      fakes.fakeRunCompletion(k),
    ]),
    ["ReviewVerdict", fakes.fakeReviewVerdict("no_objection")],
    ["ReviewVerdict", fakes.fakeReviewVerdict("blocks")],
    ...fakes.fakeRunWaitKinds.map((kind) => ["RunWait", fakes.fakeRunWait(kind)]),
    ["RunWait", fakes.fakeResolvedRunWait()],
    ...fakes.fakeRunEvents().map((event) => ["RunEvent", event]),
    ...enumOf("JobState").map((state) => ["JobStatus", fakes.fakeJobStatus(state)]),
    ["ConversationSummary", fakes.fakeConversationSummary()],
    ["PersonMemory", fakes.fakePersonMemory()],
    ["PersonMemorySuggestion", fakes.fakePersonMemorySuggestion()],
    ["NotebookEntryV2", fakes.fakeNotebookEntryV2()],
    ...fakes.fakeMemorySearchHits().map((hit) => ["MemorySearchHit", hit]),
    ["AgentRunSafety", platform.fakeAgentRunSafety("high")],
    ["AgentRunSafety", platform.fakeAgentRunSafety("medium")],
    ["AgentRunPins", platform.fakeAgentRunPins()],
  ];
  for (const [name, value] of cases) assert.ok(valid(name, value), name);
  // One fake per wait kind and per request state, so a new kind needs its fake.
  assert.deepEqual([...fakes.fakeRunWaitKinds].sort(), [...enumOf("RunWaitKind")].sort());
  // Frozen all the way down, and fresh per call.
  const plan = fakes.fakeRunPlan();
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.phases[0].items[0].evidence));
  assert.notEqual(fakes.fakeRunPlan(), plan);
  // No call or result carries credits, a balance or a countdown, so none can reach the model.
  const visible = JSON.stringify([fakes.fakeModelCall(), fakes.fakeModelResult()]);
  for (const word of ["credit", "balance", "remaining", "maxTokens", "deadline"])
    assert.equal(visible.toLowerCase().includes(word.toLowerCase()), false, word);
});

// --- Codes and the safety profile (ADR-0041 items 3, 7, 18 and 34) ----------------------
test("ADR-0041 item 34: end reasons are retired, never removed; the six new ones are writable", () => {
  const reasons = enumOf("AgentRunEndReason");
  const live = new Set(harness.liveRunEndReasons);
  const retired = new Set(harness.retiredRunEndReasons);
  assert.deepEqual([...live, ...retired].sort(), [...reasons].sort(), "live and retired cover");
  for (const reason of live) assert.equal(retired.has(reason), false, reason);
  for (const reason of [
    "person_wait_expired",
    "checkin_unanswered",
    "envelope_expired",
    "lease_lapsed",
    "internal_error",
    "released",
  ]) {
    assert.ok(live.has(reason), reason);
    assert.ok(harness.writableEndReason(reason), reason);
  }
  // No limit ends healthy work: the limit endings stay readable in old records only.
  for (const reason of ["turn_limit", "tool_call_limit", "wall_time", "deadline"]) {
    assert.ok(retired.has(reason), reason);
    assert.equal(harness.writableEndReason(reason), false, reason);
  }
  assert.equal(harness.writableEndReason("credits_exhausted"), false, "never existed here");
  assert.equal(harness.writableEndReason(7), false);
  for (const reason of harness.lapsedWaitEndReasons) assert.ok(live.has(reason), reason);
  // Who pays, pinned exactly so that H8's settlement cannot charge a run Morrow or the provider
  // ended (OD-2026-10-26-2). ADR-0039 item 2(g)'s free list less its retired limit endings, then
  // ADR-0041 item 3(d)'s internal_error and the three readings the brief puts to the owner.
  const adr0039Free = [
    "provider_error",
    "spend_limit",
    "invalid_output",
    "refusal",
    "prefix_mismatch",
    "lease_ended",
    "switch_off",
    "wall_time",
    "deadline",
  ];
  assert.deepEqual(
    [...harness.freeRunEndReasons].sort(),
    [
      ...adr0039Free.filter((reason) => !retired.has(reason)),
      "internal_error",
      "lease_lapsed",
      "envelope_expired",
      "cost_budget",
    ].sort(),
  );
  for (const reason of ["lease_ended", "switch_off"])
    assert.ok(harness.freeRunEndReasons.includes(reason), reason);
  // 2(g)'s charged list less what retired or never existed here, then the successors of its
  // question_unanswered and an idle teammate's release.
  const adr0039Metered = [
    "completed",
    "credits_exhausted",
    "turn_limit",
    "tool_call_limit",
    "stopped",
    "task_closed",
    "mandate_ended",
    "question_unanswered",
  ];
  assert.deepEqual(
    [...harness.meteredRunEndReasons].sort(),
    [
      ...adr0039Metered.filter((reason) => live.has(reason)),
      "person_wait_expired",
      "checkin_unanswered",
      "released",
    ].sort(),
  );
  // Every live reason is free or metered, never both, so a new reason needs its own decision.
  const free = new Set(harness.freeRunEndReasons);
  assert.deepEqual([...free, ...harness.meteredRunEndReasons].sort(), [...live].sort());
  for (const reason of harness.meteredRunEndReasons) assert.equal(free.has(reason), false, reason);
  // cost_budget stays only for a booking above any possible worst case.
  assert.ok(live.has("cost_budget"));
  // Refusals: the eight new codes exist, and the retired ones stay in the enum.
  const refusals = enumOf("ToolRefusalCode");
  for (const code of [
    "parallel_limit",
    "fork_first",
    "retry_blocked",
    "recall_out_of_scope",
    "call_not_found",
    "call_not_idle",
    "milestone_too_soon",
    "checkpoint_not_requested",
  ])
    assert.ok(refusals.includes(code), code);
  for (const code of harness.retiredToolRefusals) assert.ok(refusals.includes(code), code);
  for (const code of ["envelope_expired", "version_unknown", "version_revoked"])
    assert.ok(enumOf("AgentRunRefusal").includes(code), code);
  for (const kind of harness.personWaitKinds) assert.ok(enumOf("RunWaitKind").includes(kind));
  for (const state of harness.terminalJobStates) assert.ok(enumOf("JobState").includes(state));
});

test("AgentRunSafety@1: the seeds pass, the schema holds only safety ranges, and code holds the orderings", () => {
  for (const effort of ["high", "medium"]) {
    const safety = platform.fakeAgentRunSafety(effort);
    assert.deepEqual(harness.checkRunSafety(safety), [], effort);
  }
  const seed = platform.fakeAgentRunSafety("high");
  assert.equal(seed.turn.maxOutputTokens, 64000);
  assert.equal(platform.fakeAgentRunSafety("medium").turn.maxOutputTokens, 32000);
  refuses("AgentRunSafety", [
    ["max_tokens above 128,000", edit(seed, (s) => (s.turn.maxOutputTokens = 128001))],
    ["a call budget above 30 minutes", edit(seed, (s) => (s.turn.callBudgetMs = 1_800_001))],
    ["33 children", edit(seed, (s) => (s.checkIns.children = 33))],
    ["more than 100,000 turns", edit(seed, (s) => (s.checkIns.modelTurns = 100001))],
    ["a lease above 30 minutes", edit(seed, (s) => (s.lease.ms = 1_800_001))],
    ["a person wait under a day", edit(seed, (s) => (s.personWait.ms = day - 1))],
    ["a person wait over 365 days", edit(seed, (s) => (s.personWait.ms = 365 * day + 1))],
    // OD-2026-10-26-12: credits are the only budget, so no check-in rests on a total of spend.
    ["a cost check-in", edit(seed, (s) => (s.checkIns.costMultiple = 5))],
    ["a cost check-in's fallback", edit(seed, (s) => (s.checkIns.costFallbackUsd = "25"))],
    ["the retired turn cap", edit(seed, (s) => (s.maxTurns = 16))],
    ["a money cap", edit(seed, (s) => (s.holdUsd = "3.84"))],
    ["no detectors", edit(seed, (s) => delete s.detectors)],
  ]);
  const problems = (change) => harness.checkRunSafety(edit(seed, change));
  for (const [expected, change] of [
    ["repetition: nudge before trip", (s) => (s.detectors.repetition.nudgeAt = 4)],
    ["errorStreak: nudge before trip", (s) => (s.detectors.errorStreak.nudgeAt = 5)],
    ["alternation: nudge before trip", (s) => (s.detectors.alternation.nudgeAfterSteps = 8)],
    [
      "detectors: the signature ring holds a trip's window",
      (s) => {
        s.detectors.signatureRing = 8;
        s.detectors.alternation.tripAfterSteps = 10;
      },
    ],
    ["lease: renew before it lapses", (s) => (s.lease.renewBelowMs = s.lease.ms)],
    [
      "turn: the call budget plus 2 minutes fits 30 minutes",
      (s) => (s.turn.callBudgetMs = 1_700_000),
    ],
    ["envelope: active time fits the wall clock", (s) => (s.envelope.activeMs = 8 * day)],
    [
      "checkIns: the active-time check-in comes no later than the envelope",
      (s) => (s.checkIns.activeMs = 2 * day),
    ],
    [
      "checkIns: the requester's-act check-in comes no later than the envelope",
      (s) => (s.checkIns.sinceRequesterActMs = 8 * day),
    ],
    [
      "personWait: reminders ascend inside the wait",
      (s) => (s.personWait.remindersMs = [3 * day, day]),
    ],
    [
      "personWait: reminders ascend inside the wait",
      (s) => (s.personWait.remindersMs = [day, 7 * day]),
    ],
    [
      "providerBackoff: the schedule ascends",
      (s) => (s.providerBackoff.scheduleMs = [300_000, 60_000]),
    ],
    [
      "providerBackoff: the steady interval is the longest",
      (s) => (s.providerBackoff.thenEveryMs = 1_800_000),
    ],
    [
      "providerBackoff: the check-in comes after the first back-off",
      (s) => {
        s.providerBackoff.scheduleMs = [7_200_000];
        s.providerBackoff.thenEveryMs = 7_200_000;
        s.providerBackoff.checkInAfterMs = 3_600_000;
      },
    ],
    [
      "segments: a run rolls before any wait longer than its lease",
      (s) => (s.segments.rollBeforeWaitMs = 31 * 60_000),
    ],
    [
      "lease: a renewal at a turn step's entry covers the turn step",
      (s) => {
        s.lease.ms = 20 * 60_000;
        s.lease.renewBelowMs = 15 * 60_000;
      },
    ],
    [
      "lease: the lease kept at any other step's entry covers its 10 minutes",
      (s) => (s.lease.renewBelowMs = 5 * 60_000),
    ],
  ])
    assert.ok(problems(change).includes(expected), expected);
  // ADR-0041 items 6 and 7: whatever remains at a step's entry, the lease kept after the renewal
  // check covers the step, so the sweep never closes healthy work lease_lapsed mid-call. The
  // seeds' turn step (28 minutes plus 2) is longer than renewBelowMs (20 minutes), so a turn step
  // always renews; renewing it only below 20 minutes would start a 30-minute call on 20.
  for (const effort of ["high", "medium"]) {
    const safety = platform.fakeAgentRunSafety(effort);
    const timeouts = { turn: harness.turnStepTimeoutMs(safety), other: harness.otherStepTimeoutMs };
    assert.equal(timeouts.turn, 30 * 60_000, effort);
    assert.ok(timeouts.turn > safety.lease.renewBelowMs, "the case the turn rule exists for");
    for (const step of ["turn", "other"])
      for (let remaining = 0; remaining <= safety.lease.ms; remaining += 30_000) {
        const kept = harness.leaseRenewalDue(safety, step, remaining) ? safety.lease.ms : remaining;
        assert.ok(kept >= timeouts[step], `${effort}: a ${step} step entered with ${remaining} ms`);
      }
  }
  assert.equal(harness.leaseRenewalDue(seed, "turn", 25 * 60_000), true);
  assert.equal(harness.leaseRenewalDue(seed, "other", 25 * 60_000), false);
  assert.equal(harness.leaseRenewalDue(seed, "other", 19 * 60_000), true);
});

test("ADR-0041 item 6: segment instance ids and wake event types follow one rule", () => {
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(harness.segmentInstanceId(uuid, 1, 1), `${uuid}-s1-i1`);
  assert.equal(harness.segmentInstanceId(uuid, 1_000_000, 1000).length <= 100, true);
  for (const [runId, segment, incarnation] of [
    ["r".repeat(95), 1, 1],
    [uuid, 0, 1],
    [uuid, 1, 0],
    [uuid, 1, 1001],
    [uuid, 1.5, 1],
    ["run.with.dots", 1, 1],
    ["-leading-dash", 1, 1],
    [42, 1, 1],
  ])
    assert.throws(
      () => harness.segmentInstanceId(runId, segment, incarnation),
      /SEGMENT_INSTANCE_INVALID/,
      String(runId),
    );
  assert.equal(harness.waitEventType(7), "w-7");
  for (const bad of [0, -1, 1.5, 1_000_001, "7"])
    assert.throws(() => harness.waitEventType(bad), /WAIT_SEQUENCE_INVALID/, String(bad));
});

// --- The context policy (ADR-0041 items 10 to 12) ----------------------------------------
test("ContextPolicy@1: version 1 is proposed, generated with its digests, and nothing is active", async () => {
  assert.equal(activeContextPolicyVersion, null);
  assert.equal(activeContextPolicyRow("claude_opus_5_5", "high"), null);
  assert.equal(contextPolicyStatus(1), "proposed");
  assert.equal(contextPolicyStatus(2), null);
  // Opus 5.5 at medium and high only: no low effort and no other model has a row.
  assert.equal(contextPolicyRow(1, "claude_opus_5_5", "low"), null);
  assert.equal(contextPolicyRow(1, "claude_sonnet_5_5", "medium"), null);
  for (const entry of generatedContextPolicy.versions)
    for (const row of entry.rows) {
      const { digest: pinned, ...body } = row;
      assert.ok(valid("ContextPolicy", body), `${row.model}/${row.effort}`);
      assert.equal(pinned, contextPolicyDigest(body));
      assert.equal(pinned, createHash("sha256").update(jcs(body), "utf8").digest("hex"));
    }
  // The committed module reproduces from the policy file.
  const outputs = await generateContextPolicy();
  assert.equal(
    outputs[generatedContextPolicyPath],
    readFileSync(generatedContextPolicyPath, "utf8"),
  );
});

test("ContextPolicy@1: the seed thresholds, the reduction ladder and the hard guard", () => {
  const row = fakes.fakeContextPolicy("high");
  assert.deepEqual(
    { ...contextThresholds(row) },
    {
      workingWindowTokens: 200000,
      clearFromTokens: 100000,
      minimumClearTokens: 20000,
      compactAtTokens: 160000,
      backgroundCompactFromTokens: null,
      newEpochTargetTokens: 80000,
      keptTailTokens: 25000,
      ledgerTokens: 10000,
      checkpointTokens: 12000,
      fixedOpeningTokens: 25000,
      perTurnResultTokens: 30000,
      inlineResultTokens: 24000,
      previewTokens: 1000,
      hardGuardTokens: 500000,
    },
  );
  // The fallback strategy never clears on the server; the provider strategy clears from 0.50W.
  assert.equal(contextStep(row, 120000, 64000, false), "send");
  assert.equal(contextStep(row, 120000, 64000, true), "clear");
  assert.equal(contextStep(row, 99999, 64000, true), "send");
  // Compaction comes before the send at 0.80W, whatever the strategy.
  for (const provider of [false, true]) {
    assert.equal(contextStep(row, 160000, 64000, provider), "compact");
    assert.equal(contextStep(row, 436000, 64000, provider), "compact");
  }
  // Input plus max_tokens past half the model window is refused, never terminal.
  assert.equal(contextStep(row, 436001, 64000, false), "refuse_input_over_cap");
  for (const [input, output] of [
    [-1, 1],
    [1.5, 1],
    [1, 0],
  ])
    assert.throws(() => contextStep(row, input, output, false), /CONTEXT_STEP_INPUT_INVALID/);
  // One TTL policy per context kind for the context's life.
  assert.deepEqual(cacheTtls(row, "conversation"), { system: "1h", rest: "1h" });
  assert.deepEqual(cacheTtls(row, "job"), { system: "1h", rest: "1h" });
  assert.deepEqual(cacheTtls(row, "call"), { system: "1h", rest: "5m" });
  // One-hour entries always come before five-minute ones.
  assert.equal(
    valid(
      "ContextPolicy",
      edit(row, (r) => (r.cache.call = { system: "5m", rest: "1h" })),
    ),
    false,
  );
});

test("ContextPolicy@1: the generator refuses a row a new epoch could not converge under", () => {
  const row = fakes.fakeContextPolicy("medium");
  assert.deepEqual(inspectContextPolicyRow(row), []);
  const fails = (change, expected) => {
    const problems = inspectContextPolicyRow(edit(row, change));
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `${expected}: ${problems.join("; ")}`,
    );
  };
  fails(
    (r) => (r.hardGuardBasisPoints = 1000),
    "the working window must fit inside the hard guard",
  );
  fails((r) => {
    r.clear.minimumBasisPoints = 5000;
    r.clear.fromBasisPoints = 4000;
  }, "clearing must clear");
  fails((r) => (r.clear.fromBasisPoints = 8000), "clearing starts before compaction");
  fails((r) => (r.compact.backgroundFromBasisPoints = 9000), "background compaction starts");
  fails((r) => (r.newEpoch.targetBasisPoints = 8000), "a new epoch starts below the compaction");
  fails((r) => (r.newEpoch.targetBasisPoints = 7000), "must cut the minimum share");
  fails((r) => (r.newEpoch.keptTailBasisPoints = 4500), "the kept tail fits");
  fails((r) => (r.opening.pinnedKnowledgeTokens = 60000), "the opening budgets");
  fails((r) => (r.results.inlineTokens = 40000), "one inline result fits");
  // Review R5: an inline result is kept whole in one tool result block, so it must fit the
  // block's bound (ModelToolResultBlock's 256 KiB) as well as the per-turn budget: 70,000 tokens
  // is 280,000 characters at the generator's own 4 a token.
  assert.equal(
    core.$defs.ModelToolResultBlock.properties.content.maxLength,
    toolResultBlockChars,
    "the generator reads the schema's bound",
  );
  fails((r) => {
    r.results.inlineTokens = 70000;
    r.results.perTurnBasisPoints = 3500;
  }, "one inline result fits a tool result block");
  assert.deepEqual(
    inspectContextPolicyRow(
      edit(row, (r) => {
        r.results.inlineTokens = 65536;
        r.results.perTurnBasisPoints = 3500;
      }),
    ),
    [],
    "65,536 tokens fill the block exactly",
  );
  fails((r) => {
    r.results.previewTokens = 10000;
    r.results.inlineTokens = 5000;
  }, "a preview");
  fails((r) => (r.results.perTurnBasisPoints = 4000), "a new epoch plus one turn of results");
  fails((r) => (r.hardGuardBasisPoints = 3000), "the hard guard must hold a compaction request");
  fails((r) => (r.toolCalls.inFlight = 20), "in-flight calls");
  fails((r) => (r.storedMessageBytes = 65536), "a stored message must hold");
  fails((r) => (r.cache.conversation.rest = "5m"), "conversation: one hour on every breakpoint");
  fails((r) => (r.cache.upkeep = { system: "5m", rest: "5m" }), "upkeep: one hour on the system");
  // The file's own rules: statuses, eval records, one row per model and effort.
  const file = JSON.parse(readFileSync("docs/decisions/context-policy.json", "utf8"));
  const validate = (value) => valid("ContextPolicy", value);
  assert.deepEqual(inspectContextPolicy(file, validate), []);
  const fileFails = (change, expected) => {
    const problems = inspectContextPolicy(edit(file, change), validate);
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `${expected}: ${problems.join("; ")}`,
    );
  };
  fileFails((f) => (f.versions[0].status = "active"), "names its eval record");
  fileFails((f) => (f.versions[0].eval_record = "docs/evals/x.json"), "names its eval record");
  fileFails((f) => (f.active_version = 1), "active_version names the active version");
  fileFails((f) => f.versions[0].rows.push(f.versions[0].rows[0]), "one row per model and effort");
  fileFails((f) => (f.versions[0].rows[0].version = 2), "a row names its version");
  fileFails((f) => (f.versions[0].rows[0].effort = "Low"), "not a valid ContextPolicy@1");
  fileFails((f) => f.versions.push(structuredClone(f.versions[0])), "versions ascend");
  fileFails((f) => {
    const second = structuredClone(f.versions[0]);
    second.version = 2;
    for (const r of second.rows) r.version = 2;
    for (const v of [f.versions[0], second]) {
      v.status = "active";
      v.eval_record = "docs/evals/context-v1.json";
      for (const r of v.rows) r.evalRecord = v.eval_record;
    }
    f.versions.push(second);
  }, "at most one active version");
  assert.deepEqual(inspectContextPolicy({ ...file, extra: 1 }, validate), [
    "context-policy.json: malformed",
  ]);
});

// --- Context records (ADR-0041 items 4, 11, 13 and 14) -----------------------------------
test("ContextEpoch@1 and ContextCheckpoint@1: references, never copies; the checkpoint claims nothing", () => {
  const first = fakes.fakeContextEpoch("initial");
  const second = fakes.fakeContextEpoch("compaction");
  refuses("ContextEpoch", [
    ["an initial epoch after the first", edit(first, (e) => (e.epoch = 2))],
    ["a first epoch that is not initial", edit(second, (e) => (e.epoch = 1))],
    ["an initial epoch with a cut", edit(first, (e) => (e.cutSequence = 3))],
    ["a compaction without its cut", edit(second, (e) => (e.cutSequence = null))],
    ["a compaction without its checkpoint", edit(second, (e) => (e.opening.checkpoint = null))],
    [
      "an expiry while the epoch is open",
      edit(first, (e) => (e.expiresAt = "2027-01-24T09:00:00.000Z")),
    ],
    ["a copy of the opening's text", edit(first, (e) => (e.opening.text = "Improve my titles."))],
    ["an unknown epoch kind", edit(second, (e) => (e.kind = "summary"))],
  ]);
  assert.ok(
    valid(
      "ContextEpoch",
      edit(first, (e) => {
        e.closedAt = "2026-10-27T09:00:00.000Z";
        e.expiresAt = "2027-01-25T09:00:00.000Z";
      }),
    ),
  );
  for (const kind of ["reset", "view_rebase", "model_rebase", "renderer_rebase", "clear"])
    assert.ok(valid("ContextEpoch", { ...second, kind }), kind);
  const fallback = fakes.fakeContextCheckpoint("fallback");
  const provider = fakes.fakeContextCheckpoint("provider_compaction");
  // ADR-0041 items 4 and 11: the stored provider block is the next epoch's head, so the broker,
  // which builds every request from SQL, reads it from the checkpoint the opening names.
  assert.equal(typeof provider.block, "string");
  assert.equal(fallback.block, null);
  assert.equal(
    core.$defs.ContextCheckpoint.properties.block.anyOf[0].$ref,
    "#/$defs/CompactionBlock",
  );
  assert.equal(core.$defs.ModelCompaction.properties.continuity.$ref, "#/$defs/CompactionBlock");
  assert.ok(valid("ModelCompaction", { summary: provider.summary, continuity: provider.block }));
  refuses("ContextCheckpoint", [
    ["a provider compaction without its block", edit(provider, (c) => (c.block = null))],
    ["a provider compaction missing the field", edit(provider, (c) => delete c.block)],
    ["a fallback with a provider block", edit(fallback, (c) => (c.block = provider.block))],
    ["an empty block", edit(provider, (c) => (c.block = ""))],
    ["a block that is not opaque base64", edit(provider, (c) => (c.block = "not base64!"))],
    ["a block over 1 MiB", edit(provider, (c) => (c.block = "A".repeat(1_048_577)))],
    ["a fallback with a provider summary", edit(fallback, (c) => (c.summary = "x"))],
    ["a provider block with fallback content", { ...provider, content: fallback.content }],
    [
      "a rejected validation without its code",
      edit(fallback, (c) => (c.validation = { result: "rejected", code: null })),
    ],
    [
      "a valid validation with a code",
      edit(fallback, (c) => (c.validation = { result: "valid", code: "claims_approval" })),
    ],
    // No model-written field can claim an approval, a consent, an apply or a payment, and no
    // field states a proposal's or operation's state: the ledger renders those from SQL.
    ["an approval field", edit(fallback, (c) => (c.content.approved = [{ label: "p1" }]))],
    ["a stated-state field", edit(fallback, (c) => (c.content.states = [{ label: "p1" }]))],
    ["a model-chosen label", edit(fallback, (c) => (c.content.facts[0].refs = ["price1"]))],
    ["a label of no record kind", edit(fallback, (c) => (c.content.done[0].refs = ["j1"]))],
    ["a status outside the closed set", edit(fallback, (c) => (c.content.status = "applied"))],
    ["a decision without its reason", edit(fallback, (c) => delete c.content.decisions[0].reason)],
    ["a fact without its exact flag", edit(fallback, (c) => delete c.content.facts[0].exact)],
    [
      "more than 64 entries to reopen",
      edit(fallback, (c) => (c.content.reopen = Array(65).fill(c.content.reopen[0]))),
    ],
    ["no audience", edit(fallback, (c) => delete c.audience)],
    [
      "a duplicate taint kind",
      edit(
        fallback,
        (c) => (c.taint = { kinds: ["other_member", "other_member"], sourceCount: 2 }),
      ),
    ],
  ]);
  for (const code of enumOf("CheckpointRejection"))
    assert.ok(
      valid(
        "ContextCheckpoint",
        edit(fallback, (c) => (c.validation = { result: "rejected", code })),
      ),
      code,
    );
  // Labels are code's: one letter for the kind of record (memory.read's letter map, H5), then a
  // number of at most six digits. A tool result's label is the c letter from 1.
  for (const label of ["c17", "e2", "k1", "m1", "o4", "p1", "q2", "r5", "t3", "c999999"])
    assert.ok(valid("ContextLabel", label), label);
  for (const label of ["i9", "j1", "x1", "C1", "p", "p1a", "p-1", "c1234567"])
    assert.equal(valid("ContextLabel", label), false, label);
  for (const label of ["c1", "c17", "c999999"]) {
    assert.ok(valid("ToolResultLabel", label), label);
    assert.ok(valid("ContextLabel", label), `${label} resolves in memory.read`);
  }
  for (const label of ["c0", "c1000000", "e1", "t1"])
    assert.equal(valid("ToolResultLabel", label), false, label);
});

test("ContextLedger@1: SQL's records, with every in-flight operation shown as unknown", () => {
  const ledger = fakes.fakeContextLedger();
  assert.equal(ledger.operations[0].unknown, true);
  // Every status whose outcome is unreconciled shows UNKNOWN, cancel_requested included (the
  // gateway can still end it verifying, the change applied); a settled status may show known.
  // The schema's binding is code's one set, which the renderer and the request card read too.
  const unknown = new Set(harness.unknownOperationStatuses);
  assert.ok(unknown.has("cancel_requested"));
  const binding =
    core.$defs.ContextLedger.properties.operations.items.allOf[0].if.properties.status.enum;
  assert.deepEqual([...binding].sort(), [...unknown].sort(), "the schema binds code's set");
  for (const status of enumOf("OperationStatus")) {
    const shownKnown = edit(ledger, (l) => {
      l.operations[0].status = status;
      l.operations[0].unknown = false;
    });
    assert.equal(valid("ContextLedger", shownKnown), !unknown.has(status), status);
  }
  refuses("ContextLedger", [
    ...harness.unknownOperationStatuses.map((status) => [
      `a ${status} operation shown as known`,
      edit(ledger, (l) => {
        l.operations[0].status = status;
        l.operations[0].unknown = false;
      }),
    ]),
    [
      "a truncated post over 1,000 characters",
      edit(ledger, (l) => {
        l.requests[0].truncated = true;
        l.requests[0].text = "x".repeat(1001);
      }),
    ],
    ["a refusal without its next step", edit(ledger, (l) => delete l.refusals[0].next)],
    ["an unknown refusal code", edit(ledger, (l) => (l.refusals[0].code = "too_many_turns"))],
    [
      "more than eight open waits",
      edit(ledger, (l) => (l.waits = Array(9).fill({ waitId: "w", kind: "slot" }))),
    ],
    ["an omitted count missing", edit(ledger, (l) => delete l.omitted.calls)],
    ["a model summary inside the ledger", edit(ledger, (l) => (l.summary = "All approved."))],
  ]);
  assert.ok(
    valid(
      "ContextLedger",
      edit(ledger, (l) => {
        l.operations[0].status = "verified";
        l.operations[0].unknown = false;
      }),
    ),
  );
});

// --- One set of records with H5's tool inputs (review R1; pull request 79) ----------------
// H5 merged first (966fed03); these tests read H5's own definitions from core v1.1, so a change
// on either side fails here instead of merging silently (docs/briefs/h6-harness-contracts.md,
// "Merge order with H5").
const h5 = (name) => {
  const definition = core.$defs[name];
  assert.ok(definition, `${name}: H5's definition (pull request 79) is in core v1.1`);
  return definition;
};
const enumFrom = (name) => h5(name).enum;
const anyOfType = (node, type) => node.anyOf.find((branch) => branch.type === type);

test("review R1: one ContextLabel, whose letters resolve in memory.read to the record kinds the ledger renders", () => {
  // One definition: memory.read's label target, the checkpoint's lines and the ledger's rows
  // name the same ContextLabel.
  const label = h5("ContextLabel");
  assert.equal(h5("MemoryReadTarget").properties.label.anyOf[0].$ref, "#/$defs/ContextLabel");
  assert.equal(h5("CheckpointLine").properties.refs.items.$ref, "#/$defs/ContextLabel");
  // Each letter names one record kind in the definition both PRs share.
  const kinds = {
    c: "a tool result",
    e: "an earlier checkpoint",
    k: "a knowledge page",
    m: "a message",
    o: "a gateway operation",
    p: "a proposal",
    q: "a question",
    r: "a result item",
    t: "a turn",
  };
  for (const [letter, kind] of Object.entries(kinds))
    assert.ok(label.description.includes(`${letter} ${kind}`), `${letter}: ${kind}`);
  assert.equal(label.pattern, `^[${Object.keys(kinds).join("")}][0-9]{1,6}$`);
  // The ledger labels each row with its own kind's letter, so memory.read of that label opens
  // the same record: posts m, questions q, proposals p, operations o; records, calls and
  // refusals by the tool call that made them (c), or none when another context made them.
  const ledger = fakes.fakeContextLedger();
  const sections = [
    ["requests", "m", "q1"],
    ["questions", "q", "m1"],
    ["proposals", "p", "o1"],
    ["operations", "o", "p1"],
    ["records", "c", "r1"],
    ["calls", "c", "k1"],
    ["refusals", "c", "e1"],
  ];
  for (const [section, letter, wrong] of sections) {
    assert.ok(ledger[section][0].label.startsWith(letter), section);
    assert.equal(
      valid(
        "ContextLedger",
        edit(ledger, (l) => (l[section][0].label = wrong)),
      ),
      false,
      `${section} labelled ${wrong}`,
    );
  }
  for (const section of ["records", "calls"])
    assert.ok(
      valid(
        "ContextLedger",
        edit(ledger, (l) => (l[section][0].label = null)),
      ),
      section,
    );
  refuses("ModelPostBlock", [
    [
      "a post labelled as a turn",
      {
        type: "post",
        messageId: "m_1",
        label: "t1",
        authorPrincipalId: "p_1",
        postedAt: "2026-10-26T09:00:00.000Z",
        text: "x",
      },
    ],
  ]);
  // Every label a derived fake carries is one memory.read resolves.
  const labels = [];
  const walk = (value, key) => {
    if (Array.isArray(value)) for (const v of value) walk(v, key);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) walk(v, k);
    else if (["label", "ref"].includes(key) && typeof value === "string") labels.push(value);
    else if (key === "refs" && typeof value === "string") labels.push(value);
  };
  walk([
    fakes.fakeContextLedger(),
    fakes.fakeContextCheckpoint("fallback"),
    fakes.fakeMemorySearchHits(),
  ]);
  assert.ok(labels.length > 10);
  for (const value of labels) assert.ok(valid("ContextLabel", value), value);
});

test("review R1: memory.search's layers are the layers its hits name, and a hit is memory.read's target", () => {
  const layers = enumFrom("MemoryLayer");
  assert.equal(core.$defs.MemorySearchHit.properties.layer.$ref, "#/$defs/MemoryLayer");
  assert.equal(h5("ToolInputMemorySearch").properties.layers.items.$ref, "#/$defs/MemoryLayer");
  // Every kind a hit names is one memory.read opens.
  const readKinds = enumFrom("MemoryReadKind");
  const hitKinds = core.$defs.MemorySearchHit.properties.readKind.anyOf[0].enum;
  for (const kind of hitKinds) assert.ok(readKinds.includes(kind), kind);
  // One hit per layer, each opened as memory.read states its target.
  const base = fakes.fakeMemorySearchHits()[0];
  const perLayer = {
    knowledge: [["knowledge_page", null]],
    notebook: [["notebook_entry", null]],
    person_memory: [["person_memory", null]],
    conversation: [
      ["messages", 7],
      ["conversation_summary", null],
    ],
    results: [
      ["result_item", null],
      ["teammate_result", null],
    ],
    plan: [[null, null]],
  };
  assert.deepEqual(Object.keys(perLayer), layers);
  for (const [layer, targets] of Object.entries(perLayer))
    for (const [readKind, position] of targets)
      assert.ok(
        valid("MemorySearchHit", { ...base, layer, readKind, position }),
        `${layer}/${readKind}`,
      );
  refuses("MemorySearchHit", [
    ["H6's old result_item layer", { ...base, layer: "result_item" }],
    ["H6's old checkpoint layer", { ...base, layer: "checkpoint" }],
    ["H6's old plan_note layer", { ...base, layer: "plan_note" }],
    ["a results hit opened as a page", { ...base, layer: "results", readKind: "knowledge_page" }],
    ["a plan hit opened by memory.read", { ...base, layer: "plan", readKind: "result_item" }],
    [
      "a message hit without its position",
      { ...base, layer: "conversation", readKind: "messages" },
    ],
    ["a page hit with a position", { ...base, position: 3 }],
    ["a label target", { ...base, readKind: "label" }],
  ]);
});

test("review R1: context.checkpoint's input is a storable checkpoint body", () => {
  // Every key H5's input requires, with every list filled: the body the fallback stores.
  const input = {
    objective: { text: "Clearer titles for the summer dresses", refs: ["m1"] },
    status: "finishing",
    statusNote: null,
    done: [{ text: "Read 14 dresses", refs: ["c3"] }],
    inProgress: [{ text: "Waiting on the owner", refs: ["p1", "o1"] }],
    decisions: [{ decision: "Brand first", reason: "The owner asked", refs: ["m1", "q1"] }],
    setAside: [{ option: "Descriptions", reason: "Out of scope", refs: [] }],
    facts: [{ fact: "product:3", exact: true, refs: ["c3", "r1"] }],
    difficulties: [{ problem: "Two titles were long", resolution: null, refs: ["t4"] }],
    promised: [{ text: "Say when live", refs: ["p1"] }],
    nextSteps: [{ text: "Review the set", refs: [] }],
    reopen: [{ ref: "e1", why: "The earlier hand-off" }],
  };
  assert.ok(valid("ContextCheckpointContent", input));
  const fallback = fakes.fakeContextCheckpoint("fallback");
  assert.ok(valid("ContextCheckpoint", { ...fallback, content: input }));
  // One shape: ContextCheckpointContent is either a $ref to H5's input or the same properties,
  // bounds and required keys, so every input the tool accepts is a storable body.
  const tool = h5("ToolInputContextCheckpoint");
  assert.ok(valid("ToolInputContextCheckpoint", input));
  assert.ok(valid("ToolInputContextCheckpoint", fallback.content), "the fake is an input");
  const body = core.$defs.ContextCheckpointContent;
  if (body.$ref) assert.equal(body.$ref, "#/$defs/ToolInputContextCheckpoint");
  else
    for (const key of ["type", "properties", "required", "additionalProperties"])
      assert.deepEqual(body[key], tool[key], key);
});

test("review R1: run.complete's outcomes, criteria and evidence are RunCompletion's", () => {
  const outcomes = enumFrom("RunCompleteOutcome");
  assert.deepEqual(enumOf("RunCompletionOutcome"), outcomes, "the record keeps every outcome");
  // One definition under both names: the records' vocabularies are run.plan's, run.complete's
  // and the teammate result's, so neither side can change one alone.
  for (const [record, input] of [
    ["RunCompletionOutcome", "RunCompleteOutcome"],
    ["PlanItemStatus", "RunPlanItemStatus"],
    ["PlanCheckKind", "RunPlanCheckKind"],
    ["LedgerNext", "TeammateNext"],
    ["ContextCheckpointContent", "ToolInputContextCheckpoint"],
  ]) {
    h5(input);
    assert.equal(core.$defs[record].$ref, `#/$defs/${input}`, record);
  }
  const done = fakes.fakeRunCompletion("done");
  const waiting = fakes.fakeRunCompletion("waiting");
  for (const outcome of outcomes)
    assert.ok(
      valid("RunCompletion", { ...(outcome === "waiting" ? waiting : done), outcome }),
      outcome,
    );
  const statuses = h5("TeammateCriterionReport").properties.status.enum;
  for (const status of statuses)
    assert.ok(
      valid(
        "RunCompletion",
        edit(done, (c) => (c.criteria[0].status = status)),
      ),
      status,
    );
  // Every record kind run.plan, run.complete and a verdict cite is evidence the records hold.
  const kinds = enumFrom("TeammateRecordKind");
  for (const kind of kinds) assert.ok(valid("PlanEvidenceRef", { kind, id: "rec_1" }), kind);
});

test("review R1: the plan, its completion, a verdict and a suggestion hold as much as their tools accept", () => {
  // H5's array bounds, read from its definitions: the record is at least as large.
  const h5Bound = (name, path) => {
    let node = h5(name);
    for (const key of path) node = node?.[key];
    return node;
  };
  const d = core.$defs;
  const pairs = [
    [
      "plan criteria",
      h5Bound("RunPlanSetInput", ["properties", "criteria", "maxItems"]),
      d.RunPlan.properties.criteria.maxItems,
    ],
    [
      "plan phases",
      h5Bound("RunPlanSetInput", ["properties", "phases", "maxItems"]),
      d.RunPlan.properties.phases.maxItems,
    ],
    [
      "items per phase",
      h5Bound("RunPlanPhaseInput", ["properties", "items", "maxItems"]),
      d.RunPlan.properties.phases.items.properties.items.maxItems,
    ],
    [
      "an item's criteria",
      h5Bound("RunPlanItemInput", ["properties", "criteria", "maxItems"]),
      d.PlanItem.properties.criteria.maxItems,
    ],
    [
      "an item's dependencies",
      h5Bound("RunPlanItemInput", ["properties", "dependsOn", "maxItems"]),
      d.PlanItem.properties.dependsOn.maxItems,
    ],
    [
      "an item's evidence",
      h5Bound("TeammateRecordRefs", ["maxItems"]),
      d.PlanItem.properties.evidence.maxItems,
    ],
    [
      "follow-through items",
      h5Bound("RunPlanSetInput", ["properties", "followThrough", "maxItems"]),
      d.RunCompletion.properties.followThrough.maxItems,
    ],
    [
      "criteria reported",
      h5Bound("ToolInputRunComplete", ["properties", "criteria", "maxItems"]),
      d.RunCompletion.properties.criteria.maxItems,
    ],
    [
      "a criterion's evidence",
      h5Bound("TeammateRecordRefs", ["maxItems"]),
      d.RunCompletion.properties.criteria.items.properties.evidence.maxItems,
    ],
    [
      "verdicts",
      h5Bound("TeammateResultInput", ["properties", "verdicts", "maxItems"]),
      d.ReviewVerdict.properties.criteria.maxItems,
    ],
    [
      "a verdict's evidence",
      h5Bound("TeammateRecordRefs", ["maxItems"]),
      d.ReviewVerdict.properties.criteria.items.properties.evidence.maxItems,
    ],
    [
      "a suggestion's title",
      h5Bound("ToolInputMemorySuggest", ["properties", "title", "maxLength"]),
      d.PersonMemorySuggestion.properties.title.maxLength,
    ],
    [
      "a suggestion's text",
      h5Bound("ToolInputMemorySuggest", ["properties", "text", "maxLength"]),
      d.PersonMemoryText.maxLength,
    ],
  ];
  for (const [label, input, record] of pairs)
    assert.ok(Number.isInteger(input) && record >= input, `${label}: ${record} >= ${input}`);
  // Review L2 of pull request 91: a criterion change's reason, which run.plan takes with no
  // length, is stored with none (the record's 1,000-character bound refused what the tool took).
  const changeReason = anyOfType(h5("RunPlanChange").properties.reason, "string");
  const storedReason = d.RunPlan.properties.change.anyOf[0].oneOf.find(
    (b) => b.properties.kind.const === "logged_reason",
  ).properties.reason;
  assert.equal(changeReason.maxLength, undefined, "run.plan's criterion-change reason");
  assert.equal(storedReason.maxLength, changeReason.maxLength, "the stored reason's bound");
  // memory.suggest's kind and title are kept, so the person saves the exact suggestion.
  assert.equal(h5("ToolInputMemorySuggest").properties.kind.$ref, "#/$defs/PersonMemoryKind");
  assert.equal(core.$defs.PersonMemorySuggestion.properties.kind.$ref, "#/$defs/PersonMemoryKind");
  const suggestion = fakes.fakePersonMemorySuggestion();
  for (const kind of enumFrom("PersonMemoryKind"))
    assert.ok(valid("PersonMemorySuggestion", { ...suggestion, kind }), kind);
  refuses("PersonMemorySuggestion", [
    ["no kind", edit(suggestion, (s) => delete s.kind)],
    ["no title", edit(suggestion, (s) => delete s.title)],
  ]);
  // Text: H5's inputs set no lengths, so the records keep none beyond ADR-0040 item 4(c)'s
  // person-facing bounds (understood 1 to 280 characters, steps of up to 80).
  const long = "x".repeat(40000);
  const plan = fakes.fakeRunPlan();
  assert.ok(
    valid(
      "RunPlan",
      edit(plan, (p) => {
        p.objective = long;
        p.criteria[0].text = long;
        p.phases[0].title = long;
        p.phases[0].items[0].title = long;
        p.phases[1].items[1].reason = long;
        p.notes[0].text = long;
      }),
    ),
    "long plan text",
  );
  assert.ok(valid("RunCompletion", { ...fakes.fakeRunCompletion("done"), reply: long }));
  assert.ok(
    valid(
      "ContextLedger",
      edit(fakes.fakeContextLedger(), (l) => (l.plan[0].title = long)),
    ),
  );
  refuses("RunPlan", [
    ["an understood line over 280 characters", { ...plan, understood: "x".repeat(281) }],
    ["a step over 80 characters", edit(plan, (p) => (p.steps[0].title = "x".repeat(81)))],
  ]);
  // H5's run.plan input carries those two bounds and each step's owner (the merge step), so a
  // longer input is that call's invalid_input, never a record the store refuses: every input
  // run.plan accepts is a storable plan's understood line and steps.
  const setInput = h5("RunPlanSetInput");
  const understood = anyOfType(setInput.properties.understood, "string");
  const stored = anyOfType(d.RunPlan.properties.understood, "string");
  assert.equal(understood.maxLength, 280, "understood bound");
  assert.equal(understood.maxLength, stored.maxLength, "the record's understood bound");
  const steps = anyOfType(setInput.properties.steps, "array");
  assert.equal(steps.maxItems, d.RunPlan.properties.steps.maxItems, "six steps");
  assert.equal(steps.items.$ref, "#/$defs/RunPlanStepInput");
  const step = h5("RunPlanStepInput");
  assert.deepEqual(step.required, ["title", "by"], "each step names who does it (4(c))");
  assert.equal(step.properties.title.maxLength, 80, "step bound");
  assert.equal(step.properties.title.maxLength, d.PlanStepLine.properties.title.maxLength);
  for (const value of fakes.fakeRunPlan().steps)
    assert.ok(valid("RunPlanStepInput", value), "a stored step is a run.plan step");
  for (const value of platform.fakeRunPlanInput().plan.steps)
    assert.ok(valid("PlanStepLine", value), "a run.plan step is a stored step");
  refuses("RunPlanStepInput", [
    ["a step over 80 characters", { title: "x".repeat(81), by: "morrow" }],
    ["a step with no owner", { title: "Check" }],
    ["a plain title", "Check every title"],
  ]);
  // The model's strict shape gains only the owner: no bound it cannot take.
  const model = h5("ToolModelInputRunPlan").properties.plan.anyOf[0].properties;
  assert.deepEqual(model.steps.anyOf[0].items, {
    type: "object",
    additionalProperties: false,
    properties: { title: { type: "string" }, by: { type: "string" } },
    required: ["title", "by"],
  });
  assert.deepEqual(model.understood, { anyOf: [{ type: "string" }, { type: "null" }] });
  // A verdict keeps its reviewer's note per criterion (TeammateVerdictInput.note).
  const verdict = fakes.fakeReviewVerdict("blocks");
  assert.ok(valid("ReviewVerdict", { ...verdict, summary: long }));
  assert.equal(typeof verdict.criteria[1].note, "string");
  assert.equal(
    valid(
      "ReviewVerdict",
      edit(verdict, (v) => delete v.criteria[1].note),
    ),
    false,
  );
});

test("review R1: run kinds are ADR-0041 item 4's, H5 having retired the specialist kind", () => {
  const six = ["coordinator", "routed", "mandate", "call", "review", "upkeep"];
  const kinds = enumOf("AgentRunKind");
  for (const kind of six) assert.ok(kinds.includes(kind), kind);
  // H5 (pull request 79) retired specialist with its specs; the kinds are exactly ADR-0041 item
  // 4's, a teammate call's run is a call run (not a routed run with a flag), and it is offered
  // the call context's tools.
  assert.equal(core.$defs.SpecialistBrief, undefined, "H5 retired the specialist kind");
  assert.deepEqual(kinds, six);
  assert.equal(runContext("call", false), "call");
  assert.throws(() => runContext("routed", false, true), "no called flag");
  for (const kind of ["review", "upkeep"]) assert.throws(() => runContext(kind, false), kind);
});

test("review N1: a stored plan note keeps the records run.plan's note cites", () => {
  // RunPlanNoteInput's refs (H5) are stored on the note, never dropped: at least as many, of
  // every record kind the input names, under the same note kinds.
  const input = h5("RunPlanNoteInput");
  const note = core.$defs.PlanNote;
  assert.equal(input.properties.refs.$ref, "#/$defs/TeammateRecordRefs");
  assert.ok(note.required.includes("refs"));
  assert.ok(note.properties.refs.maxItems >= h5("TeammateRecordRefs").maxItems, "the count");
  assert.equal(note.properties.refs.items.$ref, "#/$defs/PlanEvidenceRef");
  assert.equal(note.properties.kind.$ref, input.properties.kind.$ref, "one note vocabulary");
  // Every note run.plan accepts, with the most refs of every kind, is a storable note.
  const kinds = enumFrom("TeammateRecordKind");
  const refs = Array.from({ length: h5("TeammateRecordRefs").maxItems }, (_, i) => ({
    kind: kinds[i % kinds.length],
    id: `rec_${i}`,
  }));
  for (const kind of enumFrom("RunPlanNoteKind")) {
    const written = { kind, text: "The CSV export has no SEO fields.", refs };
    assert.ok(valid("RunPlanNoteInput", written), kind);
    assert.ok(valid("PlanNote", written), kind);
  }
  const plan = fakes.fakeRunPlan();
  assert.ok(plan.notes[0].refs.length > 0, "the fake plan's note cites its message");
  refuses("RunPlan", [
    ["a note without its refs", edit(plan, (p) => delete p.notes[0].refs)],
    [
      "a note with a ref of no record kind",
      edit(plan, (p) => (p.notes[0].refs = [{ kind: "sql", id: "x" }])),
    ],
    [
      "a note with 257 refs",
      edit(plan, (p) => (p.notes[0].refs = [...refs, { kind: "message", id: "rec_more" }])),
    ],
  ]);
});

test("the merge guard: core v1.1 names each definition once", () => {
  // JSON.parse keeps the last of two equal keys, so a definition both PRs add (ContextLabel,
  // MemoryLayer, CheckpointLine, PersonMemoryKind) would otherwise survive the merge twice.
  const text = readFileSync("docs/contracts/schemas/v1.1/core.schema.json", "utf8");
  const names = [...text.matchAll(/^ {4}"([A-Za-z0-9]+)": \{$/gm)].map((m) => m[1]);
  assert.equal(names.length, Object.keys(core.$defs).length);
  assert.equal(new Set(names).size, names.length, "a definition appears twice");
});

// --- Long-horizon jobs (ADR-0041 items 16 to 19) -----------------------------------------
test("RunPlan@1, RunCompletion@1 and ReviewVerdict@1: frozen criteria, a gate, and a verdict that only blocks", () => {
  const plan = fakes.fakeRunPlan(1);
  refuses("RunPlan", [
    [
      "a first revision with a change reason",
      edit(plan, (p) => (p.change = { kind: "logged_reason", reason: "x" })),
    ],
    ["a dropped item without its reason", edit(plan, (p) => (p.phases[1].items[1].reason = null))],
    ["no done criteria", edit(plan, (p) => (p.criteria = []))],
    ["an item naming a tool", edit(plan, (p) => (p.phases[0].items[0].tool = "products.read"))],
    [
      "a criterion naming a capability",
      edit(plan, (p) => (p.criteria[0].capability = "orders.read")),
    ],
    ["a plan naming a limit", edit(plan, (p) => (p.maxTurns = 40))],
    ["a plan naming credits", edit(plan, (p) => (p.credits = "40"))],
    ["seven steps", edit(plan, (p) => (p.steps = Array(7).fill({ title: "Step", by: "morrow" })))],
    ["an understood line over 280 characters", edit(plan, (p) => (p.understood = "x".repeat(281)))],
    [
      "a key that is not a plan key",
      edit(plan, (p) => (p.phases[0].items[0].key = "Read dresses")),
    ],
    ["an unknown item status", edit(plan, (p) => (p.phases[0].items[0].status = "deleted"))],
    ["an unknown check kind", edit(plan, (p) => (p.criteria[1].check = "model_says_so"))],
  ]);
  assert.ok(
    valid(
      "RunPlan",
      edit(plan, (p) => (p.understood = null)),
    ),
    "a teammate's plan",
  );
  const done = fakes.fakeRunCompletion("done");
  refuses("RunCompletion", [
    ["waiting without a follow-through item", { ...done, outcome: "waiting" }],
    [
      "done with an unknown outcome",
      { ...done, unknownOutcomes: [platform.fakeHarnessIds.operationId] },
    ],
    ["accepted with a gate code", edit(done, (c) => (c.gate.code = "items_open"))],
    [
      "refused without its code",
      edit(done, (c) => (c.gate = { result: "verification_failed", code: null, criterion: null })),
    ],
    [
      "a criterion the model says is approved",
      edit(done, (c) => (c.criteria[0].status = "approved")),
    ],
    ["an outcome outside the closed set", { ...done, outcome: "gave_up" }],
  ]);
  const verdict = fakes.fakeReviewVerdict("no_objection");
  const blocks = fakes.fakeReviewVerdict("blocks");
  refuses("ReviewVerdict", [
    ["a fail that does not block", { ...blocks, outcome: "no_objection" }],
    ["a block with every criterion passing", { ...verdict, outcome: "blocks" }],
    ["an approval", { ...verdict, outcome: "approved" }],
    ["a verdict clearing taint", { ...verdict, clearsTaint: true }],
    ["no criteria", { ...verdict, criteria: [] }],
    ["no deliverable", edit(verdict, (v) => (v.deliverable.ids = []))],
  ]);
  // Unknown is not a fail: it does not block, and the gate marks the criterion unverified.
  assert.ok(
    valid(
      "ReviewVerdict",
      edit(verdict, (v) => (v.criteria[1].verdict = "unknown")),
    ),
  );
});

test("RunWait@1: one condition per kind, no lease, and a resolution only once resolved", () => {
  for (const kind of fakes.fakeRunWaitKinds) {
    const wait = fakes.fakeRunWait(kind);
    assert.equal(wait.condition.kind, kind);
    const other = fakes.fakeRunWaitKinds.find((k) => k !== kind);
    assert.equal(
      valid("RunWait", { ...wait, condition: fakes.fakeRunWait(other).condition }),
      false,
      kind,
    );
  }
  const children = fakes.fakeRunWait("children");
  refuses("RunWait", [
    [
      "an open wait with a resolution",
      {
        ...children,
        resolution: { code: "child_finished", leaseSource: null, at: children.openedAt },
      },
    ],
    ["a resolved wait without one", { ...children, state: "resolved" }],
    ["a wait that holds a lease", { ...children, leaseGeneration: 2 }],
    ["a wait that holds credits", { ...children, heldCredits: "6" }],
    [
      "33 children",
      edit(
        children,
        (w) => (w.condition.callIds = Array.from({ length: 33 }, (_, i) => `call_${i}`)),
      ),
    ],
    [
      "an approval wait without a proposal",
      edit(fakes.fakeRunWait("approval"), (w) => (w.condition.proposalIds = [])),
    ],
    [
      "a resolution by an unknown lease source",
      edit(fakes.fakeResolvedRunWait(), (w) => (w.resolution.leaseSource = "sweep")),
    ],
    // OD-2026-10-26-12 (ADR-0041's 2026-10-26 Amendments, item 18): no cost check-in.
    ["a cost check-in", edit(fakes.fakeRunWait("checkin"), (w) => (w.condition.code = "cost"))],
  ]);
  assert.deepEqual(
    enumOf("CheckInCode"),
    ["turns", "tool_calls", "active_time", "envelope", "children", "provider"],
    "the check-ins are backstops, the envelope, the kernel's children and the provider; none is money",
  );
  assert.ok(
    valid("RunWait", {
      ...fakes.fakeResolvedRunWait(),
      state: "lapsed",
      resolution: { code: "lapsed", leaseSource: null, at: children.openedAt },
    }),
  );
});

// --- Events and the request card (ADR-0041 item 36, ADR-0040 item 5) --------------------
test("RunEvent@1 is content-free and typed by kind; JobStatus@1 is a projection with no stop time", () => {
  const events = fakes.fakeRunEvents();
  assert.deepEqual(
    events.map((e) => e.sequence),
    events.map((_, i) => i + 1),
    "numbered per root run",
  );
  const ended = events.at(-1);
  const compacted = events.find((e) => e.kind === "context.compacted");
  const drawn = events.find((e) => e.kind === "credits.drawn");
  const opened = events.find((e) => e.kind === "wait.opened");
  refuses("RunEvent", [
    ["a run ended with a tool refusal code", { ...ended, code: "not_offered" }],
    ["a run ended with no code", { ...ended, code: null }],
    ["a compaction without its token counts", { ...compacted, tokensAfter: null }],
    ["credits drawn without the amount", { ...drawn, credits: null }],
    ["credits in dollars", { ...drawn, credits: "0.38" }],
    ["a wait event naming a run", { ...opened, ref: { kind: "run", id: "run_x" } }],
    [
      "a detector event with a check-in code",
      { ...ended, kind: "detector.tripped", code: "active_time" },
    ],
    ["content", { ...ended, text: "Proposed 12 titles." }],
    ["an unknown kind", { ...ended, kind: "model.said" }],
  ]);
  const working = fakes.fakeJobStatus("working");
  refuses("JobStatus", [
    ["checking for another reason", { ...fakes.fakeJobStatus("checking"), reason: "error" }],
    ["done without an end", { ...fakes.fakeJobStatus("done"), endedAt: null }],
    ["queued with an activity", { ...fakes.fakeJobStatus("queued"), activity: "reading_products" }],
    ["a stop time", { ...working, stopsAt: "2026-10-26T11:33:00.000Z" }],
    ["an approve control", { ...working, approve: true }],
    ["a model-written title", { ...working, title: { kind: "text", text: "Fixing titles" } }],
    ["a credit balance", { ...working, balance: "100" }],
    // Review R3 (ADR-0040 item 5): checking overrides done, stopped and failed while any
    // operation's outcome is unreconciled, and is never shown as done; so a card in one of those
    // states has none, and a checking card has at least one.
    ...["done", "stopped", "failed"].flatMap((state) =>
      [1, 2].map((n) => [
        `${state} with ${n} operation(s) unconfirmed`,
        edit(fakes.fakeJobStatus(state), (j) => (j.counts.operationsUnconfirmed = n)),
      ]),
    ),
    [
      "checking with nothing unconfirmed",
      edit(fakes.fakeJobStatus("checking"), (j) => (j.counts.operationsUnconfirmed = 0)),
    ],
  ]);
  // Every other state may hold an operation in flight.
  for (const state of enumOf("JobState").filter((s) => !["done", "stopped", "failed"].includes(s)))
    assert.ok(
      valid(
        "JobStatus",
        edit(fakes.fakeJobStatus(state), (j) => (j.counts.operationsUnconfirmed = 1)),
      ),
      state,
    );
});

// --- Memory (ADR-0041 items 25 to 30) -----------------------------------------------------
test("review R4: every stored derived row carries read tags, an audience, its source subjects and taint", () => {
  // ADR-0041 item 25: "every derived row (notebook entries, summaries, result items, plan
  // revisions, checkpoints, ledger items) carries an audience and its source subjects"; a read
  // passes only if the read tags allow it, the reader has live view of every source subject and
  // the audience matches. Result items are H5's (pull request 79).
  const rows = [
    ["ContextCheckpoint", fakes.fakeContextCheckpoint()],
    ["ContextLedger", fakes.fakeContextLedger()],
    ["RunPlan", fakes.fakeRunPlan()],
    ["ReviewVerdict", fakes.fakeReviewVerdict()],
    ["ConversationSummary", fakes.fakeConversationSummary()],
    ["NotebookEntryV2", fakes.fakeNotebookEntryV2()],
  ];
  const fields = ["readTags", "audience", "sourceSubjects", "taint"];
  for (const [name, row] of rows) {
    const def = core.$defs[name];
    for (const field of fields) {
      assert.ok(def.required.includes(field), `${name} requires ${field}`);
      assert.equal(
        valid(
          name,
          edit(row, (r) => delete r[field]),
        ),
        false,
        `${name} without ${field}`,
      );
    }
    assert.equal(def.properties.sourceSubjects.$ref, "#/$defs/SourceSubjects", name);
    assert.equal(def.properties.audience.$ref, "#/$defs/Audience", name);
  }
});

test("memory contracts: audience on every derived row, person memory only its person's, five queries", () => {
  const summary = fakes.fakeConversationSummary();
  refuses("ConversationSummary", [
    ["no audience", edit(summary, (s) => delete s.audience)],
    ["no source subjects", edit(summary, (s) => delete s.sourceSubjects)],
    [
      "a citation without its author",
      edit(summary, (s) => delete s.citations[0].authorPrincipalId),
    ],
    [
      "a quote over 1,000 characters",
      edit(summary, (s) => (s.citations[0].quote = "x".repeat(1001))),
    ],
    ["a viewer set by name", edit(summary, (s) => (s.viewers = { kind: "everyone" }))],
    ["a decided field", edit(summary, (s) => (s.decided = ["Approved the price change"]))],
  ]);
  const memory = fakes.fakePersonMemory();
  refuses("PersonMemory", [
    ["text over 1,000 characters", { ...memory, text: "x".repeat(1001) }],
    ["a workspace scope", { ...memory, scope: "workspace" }],
    ["written by an agent", { ...memory, writtenFrom: { kind: "agent", runId: "run_x" } }],
    ["an admin read flag", { ...memory, adminVisible: true }],
    ["a second principal", { ...memory, sharedWith: [platform.fakeIds.memberPrincipalId] }],
  ]);
  assert.ok(
    valid("PersonMemory", { ...memory, scope: "everywhere", writtenFrom: { kind: "typed" } }),
  );
  const suggestion = fakes.fakePersonMemorySuggestion();
  refuses("PersonMemorySuggestion", [
    ["saved without the person", { ...suggestion, state: "auto_saved" }],
    ["no expiry", edit(suggestion, (s) => delete s.expiresAt)],
    ["no digest", edit(suggestion, (s) => delete s.digest)],
  ]);
  const entry = fakes.fakeNotebookEntryV2();
  refuses("NotebookEntryV2", [
    ["schema version 1", { ...entry, schemaVersion: 1 }],
    ["an instruction kind", { ...entry, kind: "instruction" }],
    ["a deleted status", { ...entry, status: "deleted" }],
    ["no audience", edit(entry, (e) => delete e.audience)],
    ["no requester it was written for", edit(entry, (e) => delete e.writtenForPrincipalId)],
  ]);
  const hit = fakes.fakeMemorySearchHits()[0];
  refuses("MemorySearchHit", [
    ["a sixth query", { ...hit, query: 5 }],
    ["a system trust class", { ...hit, trust: "system" }],
    ["a snippet over 600 characters", { ...hit, snippet: "x".repeat(601) }],
    ["the full text", { ...hit, text: "the whole page" }],
  ]);
  refuses("Audience", [
    ["a workspace audience naming a principal", { kind: "workspace", principalId: "p" }],
    [
      "a subject outside the closed kinds",
      { kind: "subject", subject: { kind: "store", id: "s" } },
    ],
    ["an audience of everyone", { kind: "public" }],
  ]);
});

// --- Taint (ADR-0027 item 5, ADR-0041 item 34) --------------------------------------------
test("taint: one vocabulary, ModelUntrustedSource's kinds, on every derived row and joined without loss", () => {
  const kinds = enumOf("ModelUntrustedSource");
  assert.deepEqual([...harness.taintKindOrder], kinds, "joinTaint's order is the schema's");
  // ADR-0041 item 34's additions beside ADR-0040's other_member, as H5 (pull request 79) has them.
  for (const kind of [
    "teammate_result",
    "result_item",
    "notebook_entry",
    "conversation_summary",
    "person_memory",
    "context_checkpoint",
    "thread_post",
    "other_member",
  ])
    assert.ok(kinds.includes(kind), kind);
  assert.equal(core.$defs.TaintKind, undefined, "no second vocabulary of kinds");
  assert.equal(core.$defs.TaintKinds.items.$ref, "#/$defs/ModelUntrustedSource");
  assert.equal(
    core.$defs.TaintKinds.maxItems,
    kinds.length,
    "room for every kind: never truncated",
  );
  // Every derived row carries the same shape: every kind and how many sources. Any other row
  // that carries taint carries H5's RunTaint (pull request 79: results, items, proposals and
  // cards, with their first sources inline), whose kinds are the same ModelUntrustedSource; no
  // row carries a bare list of kinds or a vocabulary of its own.
  const derivedRows = [
    "RunTurn",
    "ModelStateBlock",
    "ContextCheckpoint",
    "ContextLedger",
    "RunPlan",
    "ReviewVerdict",
    "ConversationSummary",
    "NotebookEntryV2",
    "MemorySearchHit",
  ];
  for (const name of derivedRows)
    assert.equal(core.$defs[name].properties.taint.$ref, "#/$defs/DerivedTaint", name);
  const carriers = Object.entries(core.$defs).filter(([, d]) => d.properties?.taint);
  for (const [name, definition] of carriers)
    assert.ok(
      ["#/$defs/DerivedTaint", "#/$defs/RunTaint"].includes(definition.properties.taint.$ref),
      name,
    );
  refuses("DerivedTaint", [
    ["a context-taint value as a kind", { kinds: ["untrusted_external"], sourceCount: 1 }],
    ["a kind with no source", { kinds: ["product"], sourceCount: 0 }],
    ["sources with no kind", { kinds: [], sourceCount: 2 }],
    ["a duplicate kind", { kinds: ["product", "product"], sourceCount: 2 }],
    ["a bare list of kinds", ["product"]],
  ]);
  // A reader that joins a derived row keeps every kind the row carries, beside its own, and
  // never counts fewer sources than both hold.
  const reader = { kinds: ["message"], sourceCount: 2 };
  for (const kind of kinds) {
    const joined = harness.joinTaint(reader, { kinds: [kind], sourceCount: 3 });
    assert.ok(joined.kinds.includes(kind) && joined.kinds.includes("message"), kind);
    assert.equal(joined.sourceCount, 5, kind);
    assert.ok(valid("DerivedTaint", joined), kind);
  }
  const everything = harness.joinTaint(...kinds.map((kind) => ({ kinds: [kind], sourceCount: 1 })));
  assert.deepEqual(everything.kinds, kinds, "in the schema's order");
  assert.ok(valid("DerivedTaint", everything), "every kind fits");
  assert.ok(
    valid("DerivedTaint", harness.joinTaint(everything, everything)),
    "a join never grows past the kinds",
  );
  assert.deepEqual(harness.joinTaint(), { kinds: [], sourceCount: 0 });
  const most = 2_147_483_647;
  assert.equal(
    harness.joinTaint(
      { kinds: ["product"], sourceCount: most },
      { kinds: ["upload"], sourceCount: 9 },
    ).sourceCount,
    most,
    "the count saturates rather than wraps",
  );
  // The event a join writes names the kind joined.
  const event = { ...fakes.fakeRunEvents()[0], kind: "taint.joined", ref: null };
  assert.ok(valid("RunEvent", { ...event, code: "teammate_result" }));
  assert.equal(valid("RunEvent", { ...event, code: "untrusted_external" }), false);
});

test("the fork's derived fakes carry at least the taint of what they read and cite", () => {
  const ids = platform.fakeHarnessIds;
  const item = fakes.fakeMemorySearchHits().find((hit) => hit.id === ids.itemId);
  assert.ok(item.taint.kinds.length > 0, "Listings' item r1 is untrusted");
  // What the fork read: the products (c3), Listings' result (its call, c4) and the item it
  // opened (r1).
  const consumed = harness.joinTaint(
    { kinds: ["product"], sourceCount: 14 },
    { kinds: ["teammate_result"], sourceCount: 1 },
    { kinds: ["result_item"], sourceCount: 1 },
    item.taint,
  );
  const rows = [
    ["fallback checkpoint", fakes.fakeContextCheckpoint("fallback")],
    ["provider checkpoint", fakes.fakeContextCheckpoint("provider_compaction")],
    ["ledger", fakes.fakeContextLedger()],
    ["plan revision 1", fakes.fakeRunPlan(1)],
    ["plan revision 2", fakes.fakeRunPlan(2)],
    ["review with no objection", fakes.fakeReviewVerdict("no_objection")],
    ["review that blocks", fakes.fakeReviewVerdict("blocks")],
    ["conversation summary", fakes.fakeConversationSummary()],
    ["notebook entry", fakes.fakeNotebookEntryV2()],
    ...fakes.fakeMemorySearchHits().map((hit) => [`${hit.layer} hit`, hit]),
  ];
  const fromFork = rows.filter(
    ([, row]) =>
      row.contextId === ids.forkContextId ||
      row.runId === ids.forkRunId ||
      row.reviewedRunId === ids.forkRunId,
  );
  assert.equal(fromFork.length, 7, "checkpoints, ledger, plans and reviews of the fork");
  for (const [name, row] of fromFork) {
    for (const kind of consumed.kinds)
      assert.ok(row.taint.kinds.includes(kind), `${name}: ${kind}`);
    assert.ok(row.taint.sourceCount >= consumed.sourceCount, `${name}: its sources`);
  }
});

// The H5 merge step (docs/briefs/h6-harness-contracts.md): H5 (pull request 79) brought
// RunTaint, and this test runs from that merge on. A run that reads a derived row joins the
// row's DerivedTaint into its RunTaint: an untainted row adds nothing; a tainted row adds every
// kind it carries and its own kind (the kind it is read back as), itself as one inline source,
// and its counted sources as omitted, so the reader never holds fewer kinds or sources.
test("taint: a RunTaint joined from every derived fake keeps every kind", () => {
  const runTaint = core.$defs.RunTaint;
  assert.equal(runTaint.properties.kinds.items.$ref, "#/$defs/ModelUntrustedSource");
  assert.ok(runTaint.properties.kinds.maxItems >= core.$defs.TaintKinds.maxItems);
  assert.ok(
    runTaint.properties.omittedSources.maximum >=
      core.$defs.DerivedTaint.properties.sourceCount.maximum,
  );
  const readDerivedRow = (rowKind, rowId, derived) =>
    derived.kinds.length === 0
      ? { contextTaint: "none", kinds: [], sources: [], omittedSources: 0 }
      : {
          contextTaint: "untrusted_external",
          kinds: harness.taintKindOrder.filter(
            (kind) => kind === rowKind || derived.kinds.includes(kind),
          ),
          sources: [{ source: rowKind, sourceId: rowId }],
          omittedSources: derived.sourceCount,
        };
  const kinds = enumOf("ModelUntrustedSource");
  const rows = [
    ["run turn", platform.fakeRunTurn()],
    ["fallback checkpoint", fakes.fakeContextCheckpoint("fallback")],
    ["provider checkpoint", fakes.fakeContextCheckpoint("provider_compaction")],
    ["ledger", fakes.fakeContextLedger()],
    ["plan", fakes.fakeRunPlan(2)],
    ["review", fakes.fakeReviewVerdict("blocks")],
    ["conversation summary", fakes.fakeConversationSummary()],
    ["notebook entry", fakes.fakeNotebookEntryV2()],
    ...fakes.fakeMemorySearchHits().map((hit) => [`${hit.layer} hit`, hit]),
    [
      "every kind at the largest count",
      {
        taint: harness.joinTaint(
          ...kinds.map((kind) => ({ kinds: [kind], sourceCount: 2_147_483_647 })),
        ),
      },
    ],
  ];
  for (const [name, row] of rows)
    for (const rowKind of kinds) {
      const joined = readDerivedRow(rowKind, "row_fake_1", row.taint);
      assert.ok(valid("RunTaint", joined), `${name} read as ${rowKind}`);
      for (const kind of row.taint.kinds)
        assert.ok(joined.kinds.includes(kind), `${name}: ${kind}`);
      assert.ok(joined.omittedSources + joined.sources.length >= row.taint.sourceCount, name);
      assert.equal(joined.contextTaint === "none", row.taint.kinds.length === 0, name);
    }
});

// --- Message blocks and ModelResult@2's compaction (ADR-0041 items 8, 11, 13 and 15) -----
test("message blocks: posts and state stay on the user side, notices are closed codes, and a compaction is its own outcome", () => {
  const post = {
    type: "post",
    messageId: "msg_2",
    label: "m2",
    authorPrincipalId: platform.fakeIds.ownerPrincipalId,
    postedAt: "2026-10-26T09:05:00.000Z",
    text: "Leave sizes out of the titles.",
  };
  const state = {
    type: "state",
    kind: "ledger",
    digest,
    taint: { kinds: [], sourceCount: 0 },
    text: "Where the summary disagrees with these records, the records are right.",
  };
  assert.ok(valid("UserModelMessage", { role: "user", content: [post, state] }));
  assert.equal(valid("AssistantModelMessage", { role: "assistant", content: [post] }), false);
  assert.equal(valid("AssistantModelMessage", { role: "assistant", content: [state] }), false);
  assert.equal(valid("ModelStateBlock", { ...state, kind: "system" }), false);
  assert.equal(valid("ModelPostBlock", { ...post, label: "post_2" }), false, "labels are code's");
  assert.equal(valid("ModelPostBlock", { ...post, text: " " }), false);
  for (const code of enumOf("ModelNoticeCode"))
    assert.ok(valid("ModelNotice", { code, value: null }), code);
  assert.equal(valid("ModelNotice", { code: "wrap_up_now", value: null }), false, "no wrap-up");
  assert.equal(valid("ModelNotice", { code: "output_cut", value: "split the work" }), false);
  const result = fakes.fakeModelResult();
  const compacted = {
    ...result,
    outcome: "compacted",
    message: null,
    prefixDigest: null,
    compacted: { summary: "Read 14 dresses (c3).", continuity: "Y29tcGFjdA" },
  };
  assert.ok(valid("ModelResultV2", compacted));
  refuses("ModelResultV2", [
    ["a compaction with a reply", { ...compacted, message: result.message }],
    ["a compaction without its block", { ...compacted, compacted: null }],
    [
      "a compaction that also cleared",
      { ...compacted, cleared: { toolUses: 3, inputTokens: 900 } },
    ],
    ["a reply with a compaction block", { ...result, compacted: compacted.compacted }],
    ...["not_sent", "prefix_mismatch", "lease_refused", "input_over_cap"].map((outcome) => [
      `${outcome} with usage`,
      { ...result, outcome, message: null, prefixDigest: null },
    ]),
  ]);
  for (const outcome of ["not_sent", "prefix_mismatch", "lease_refused", "input_over_cap"])
    assert.ok(
      valid("ModelResultV2", {
        ...result,
        outcome,
        message: null,
        prefixDigest: null,
        usage: null,
        sectionTokens: null,
      }),
      outcome,
    );
  // A broken stream is booked: an uncertain result may carry usage.
  assert.ok(
    valid("ModelResultV2", { ...result, outcome: "uncertain", message: null, prefixDigest: null }),
  );
  // A run_turns row carries a reply only with its outcome.
  const turn = platform.fakeRunTurn();
  refuses("RunTurn", [
    ["a reply on a failed call", { ...turn, outcome: "uncertain" }],
    ["a reply on an open call", { ...turn, outcome: null }],
    ["an answered call without its reply", { ...turn, output: null }],
    ["an answered call without its digest", { ...turn, prefixDigestAfter: null }],
    [
      "a compaction row with input",
      {
        ...turn,
        purpose: "compaction",
        outcome: "compacted",
        output: null,
        prefixDigestAfter: null,
        input: { role: "user", content: [{ type: "text", text: "x" }] },
      },
    ],
  ]);
  assert.ok(
    valid("RunTurn", {
      ...turn,
      purpose: "compaction",
      outcome: "compacted",
      output: null,
      prefixDigestAfter: null,
    }),
  );
});

// --- The fake broker (ModelCall@2; ADR-0041 items 5 and 8) --------------------------------
const opening = { role: "user", content: [{ type: "text", text: "Improve my titles." }] };
const text = (value) => ({ role: "assistant", content: [{ type: "text", text: value }] });
const callOf = (store, contextId, runId, epoch, sequence, extra = {}) => ({
  call: {
    schemaVersion: 2,
    runId,
    leaseGeneration: 1,
    contextId,
    epoch,
    throughSequence: sequence,
    purpose: "turn",
    turn: sequence,
    attempt: 1,
    ...extra,
    expectedPrefixDigest:
      extra.expectedPrefixDigest ?? store.expectedPrefixDigest(contextId, epoch, sequence),
  },
});

test("the fake broker: a call reaches only the context its leased run is attached to", async () => {
  const store = createFakeContextStore();
  store.grantLease("run_a", 1);
  store.grantLease("run_b", 1);
  store.openEpoch("ctx_a", 1, opening);
  store.openEpoch("ctx_b", 1, {
    role: "user",
    content: [{ type: "text", text: "B's private Ask." }],
  });
  store.attachRun("ctx_a", "run_a");
  store.attachRun("ctx_b", "run_b");
  assert.throws(
    () => store.attachRun("ctx_a", "run_b"),
    (e) => e instanceof FakeContextStoreError && e.code === "CONTEXT_ATTACHED",
  );
  const gateway = createFakeModelGateway([{ reply: text("ok") }], { store });
  store.append("ctx_b", { epoch: 1, purpose: "turn", input: null });
  // Run A's valid lease cannot read B's context.
  const borrowed = await gateway.modelTurn(callOf(store, "ctx_b", "run_a", 1, 1));
  assert.equal(borrowed.outcome, "lease_refused");
  assert.equal(borrowed.usage, null);
  // A stale generation is refused, and so is a detached run.
  store.grantLease("run_b", 2);
  assert.equal(
    (await gateway.modelTurn(callOf(store, "ctx_b", "run_b", 1, 1))).outcome,
    "lease_refused",
  );
  assert.throws(() => store.grantLease("run_b", 2), /LEASE_INVALID/);
  store.detachRun("ctx_b", "run_b");
  assert.equal(
    (await gateway.modelTurn(callOf(store, "ctx_b", "run_b", 1, 1, { leaseGeneration: 2 })))
      .outcome,
    "lease_refused",
  );
  assert.equal(gateway.remaining(), 1, "nothing was sent");
  store.attachRun("ctx_b", "run_b");
  const answered = await gateway.modelTurn(
    callOf(store, "ctx_b", "run_b", 1, 1, { leaseGeneration: 2 }),
  );
  assert.equal(answered.outcome, "end_turn");
  assert.ok(validateCurrentDefinition("ModelResultV2", answered));
});

test("the fake broker: compaction, a new epoch, the hard guard and the append-only log", async () => {
  const store = createFakeContextStore();
  store.grantLease("run_1", 1);
  const epochOne = store.openEpoch("ctx_1", 1, opening);
  store.attachRun("ctx_1", "run_1");
  const gateway = createFakeModelGateway(
    [
      { reply: text("Reading.") },
      { compaction: { summary: "Read 14 dresses (c3).", continuity: "Y29tcGFjdA" } },
      { reply: text("Proposed.") },
    ],
    { store, toolsTokens: 4000, systemTokens: 9000 },
  );
  // The first call's expected prefix is the epoch's own digest.
  const first = store.append("ctx_1", { epoch: 1, purpose: "turn", input: null });
  assert.equal(store.expectedPrefixDigest("ctx_1", 1, first), epochOne);
  const one = await gateway.modelTurn(callOf(store, "ctx_1", "run_1", 1, first));
  assert.equal(one.outcome, "end_turn");
  assert.equal(one.sectionTokens.tools, 4000);
  assert.equal(one.sectionTokens.system, 9000);
  store.recordOutput("ctx_1", first, one.message);
  // A turn after an answered row must add something: input or a notice.
  assert.throws(
    () => store.append("ctx_1", { epoch: 1, purpose: "turn", input: null }),
    /ROW_INVALID/,
  );
  // A compaction call: the purpose must match the row, and its block is its own outcome.
  const cut = store.append("ctx_1", { epoch: 1, purpose: "compaction", input: null });
  assert.equal(
    (await gateway.modelTurn(callOf(store, "ctx_1", "run_1", 1, cut))).outcome,
    "prefix_mismatch",
    "a turn call cannot name a compaction row",
  );
  const compacted = await gateway.modelTurn(
    callOf(store, "ctx_1", "run_1", 1, cut, { purpose: "compaction" }),
  );
  assert.equal(compacted.outcome, "compacted");
  assert.equal(compacted.message, null);
  assert.ok(validateCurrentDefinition("ModelResultV2", compacted));
  store.recordOutcome("ctx_1", cut, "compacted");
  // While a row is open nothing else is appended, and a new epoch waits for it.
  const pendingRow = store.append("ctx_1", {
    epoch: 1,
    purpose: "turn",
    notices: [{ code: "resumed", value: null }],
    input: null,
  });
  assert.throws(
    () => store.append("ctx_1", { epoch: 1, purpose: "turn", input: opening }),
    /ROW_INVALID/,
  );
  assert.throws(() => store.openEpoch("ctx_1", 2, opening), /EPOCH_INVALID/);
  store.recordOutcome("ctx_1", pendingRow, "not_sent");
  // The next epoch starts from its own opening: none of epoch 1's rows are in its prefix.
  assert.throws(() => store.openEpoch("ctx_1", 3, opening), /EPOCH_INVALID/);
  const reopened = { role: "user", content: [{ type: "text", text: "Checkpoint and ledger." }] };
  const epochTwo = store.openEpoch("ctx_1", 2, reopened);
  assert.throws(
    () => store.append("ctx_1", { epoch: 1, purpose: "turn", input: opening }),
    /ROW_INVALID/,
  );
  const fresh = store.append("ctx_1", { epoch: 2, purpose: "turn", input: null });
  assert.equal(store.expectedPrefixDigest("ctx_1", 2, fresh), epochTwo);
  // An old epoch's row cannot be named by a call in the new one.
  assert.equal(
    (
      await gateway.modelTurn(
        callOf(store, "ctx_1", "run_1", 1, fresh, { expectedPrefixDigest: epochOne }),
      )
    ).outcome,
    "prefix_mismatch",
  );
  // The hard guard: input plus max_tokens past it is input_over_cap, and nothing is sent.
  const guarded = createFakeModelGateway([{ reply: text("never") }], {
    store,
    toolsTokens: 4000,
    systemTokens: 9000,
    hardGuardTokens: 40000,
    maxOutputTokens: 32000,
  });
  const over = await guarded.modelTurn(callOf(store, "ctx_1", "run_1", 2, fresh));
  assert.equal(over.outcome, "input_over_cap");
  assert.equal(over.usage, null);
  assert.equal(guarded.remaining(), 1);
  const two = await gateway.modelTurn(callOf(store, "ctx_1", "run_1", 2, fresh));
  assert.equal(two.outcome, "end_turn");
  assert.equal(gateway.remaining(), 0);
  await assert.rejects(
    gateway.modelTurn(callOf(store, "ctx_1", "run_1", 2, fresh)),
    (e) => e instanceof FakeModelGatewayError && e.code === "SCRIPT_EXHAUSTED",
  );
  // A scripted compaction for a turn call is a broken script, not a result.
  const mismatched = createFakeModelGateway([{ compaction: { summary: "x", continuity: "eA" } }], {
    store,
  });
  await assert.rejects(
    mismatched.modelTurn(callOf(store, "ctx_1", "run_1", 2, fresh)),
    (e) => e instanceof FakeModelGatewayError && e.code === "SCRIPT_MISMATCH",
  );
  // Every row the store kept is a valid run_turns shape for its outcome.
  for (const row of store.rows("ctx_1"))
    assert.equal(
      row.output === null,
      row.outcome !== "end_turn" && row.outcome !== "tool_use",
      `row ${row.sequence}`,
    );
});

// H6's carry-forward N3, closed in plan row H7a: a reply has its own stored-size limit, sized
// from the max_tokens range (not from the stored-message bound of results, which would cut
// healthy high-effort replies), and replyFit answers over_bound above it, so run_turns never
// stores a reply under a CHECK it can exceed. Without the limit every block below fits its own
// bound and replyFit said fits.
test("N3: a reply whose blocks each fit but whose stored size passes the reply limit is over_bound", () => {
  assert.equal(replyStoredBytes, 2_097_152);
  // Above the 128,000-token range at four bytes a token, with a reasoning block's continuity.
  assert.ok(replyStoredBytes >= maxOutputTokensRange * bytesPerTokenEstimate + 1_048_576);
  // Never the stored-message bound of results (384 KiB): high-effort replies pass it.
  assert.ok(replyStoredBytes > generatedContextPolicy.versions[0].rows[0].storedMessageBytes);
  const reply = (...content) => ({ role: "assistant", content });
  const block = { type: "text", text: "x".repeat(32000) };
  assert.equal(replyFit(reply(...Array(65).fill(block))), "fits");
  assert.equal(replyFit(reply(...Array(66).fill(block))), "over_bound");
  const thinking = {
    type: "reasoning",
    text: "x".repeat(1_048_576),
    continuity: "",
    redacted: false,
  };
  assert.equal(replyFit(reply(thinking, { type: "text", text: "Done." })), "fits");
  assert.equal(replyFit(reply(thinking, thinking, { type: "text", text: "Done." })), "over_bound");
  // Multi-byte text counts in UTF-8 bytes, as the stored jsonb does.
  const wide = { type: "text", text: "é".repeat(32000) };
  assert.equal(replyFit(reply(...Array(32).fill(wide))), "fits");
  assert.equal(replyFit(reply(...Array(33).fill(wide))), "over_bound");
});

test("review R2: a healthy reply past a stored bound is incomplete and resent, never a protocol break", async () => {
  // ADR-0041 item 8: only a protocol break (an unparseable reply, a different model id) ends the
  // run. The fake broker's bounds are AssistantModelMessage's, and a reasoning block holds what
  // the max_tokens range (128,000) produces at the generator's 4 bytes a token.
  const assistant = core.$defs.AssistantModelMessage;
  assert.equal(replyBounds.blocks, assistant.properties.content.maxItems);
  assert.equal(replyBounds.textChars, core.$defs.ModelTextBlock.properties.text.maxLength);
  const reasoning = core.$defs.ModelReasoningBlock.properties;
  assert.equal(replyBounds.reasoningChars, reasoning.text.maxLength);
  assert.equal(replyBounds.reasoningChars, reasoning.continuity.maxLength);
  assert.ok(replyBounds.reasoningChars >= maxOutputTokensRange * bytesPerTokenEstimate);
  const longest = maxOutputTokensRange * bytesPerTokenEstimate;
  const use = (i) => ({
    type: "tool_use",
    id: `toolu_${i}`,
    name: "products.read",
    input: { productIds: null, titleContains: "dress", limit: 5 },
  });
  const reply = (...content) => ({ role: "assistant", content });
  const thinking = {
    type: "reasoning",
    text: "x".repeat(longest),
    continuity: "A".repeat(longest),
    redacted: false,
  };
  const cases = [
    // A reply as long as max_tokens allows: one text block of 512,000 characters.
    [
      "a text reply as long as max_tokens allows",
      reply({ type: "text", text: "x".repeat(longest) }),
      "incomplete",
    ],
    [
      "a text block just past 32,000 characters",
      reply({ type: "text", text: "x".repeat(32005) }),
      "incomplete",
    ],
    ["65 tool calls", reply(...Array.from({ length: 65 }, (_, i) => use(i + 1))), "incomplete"],
    ["129 blocks", reply(...Array(129).fill({ type: "text", text: "x" })), "incomplete"],
    ["a long reasoning block", reply(thinking, { type: "text", text: "Done." }), "end_turn"],
    [
      "64 tool calls (code answers past 16 parallel_limit)",
      reply(...Array.from({ length: 64 }, (_, i) => use(i + 1))),
      "tool_use",
    ],
    // Shape breaches stay protocol breaks, however long the reply.
    ["an unknown block", reply({ type: "image", data: "eA" }), "invalid_output"],
    [
      "a long text block with an extra key",
      reply({ type: "text", text: "x".repeat(40000), cite: 1 }),
      "invalid_output",
    ],
    ["a tool outside the catalogue", reply({ ...use(1), name: "sql.run" }), "invalid_output"],
    ["no blocks", reply(), "invalid_output"],
    ["a user turn", { role: "user", content: [{ type: "text", text: "x" }] }, "invalid_output"],
  ];
  for (const [label, value, expected] of cases) {
    const store = createFakeContextStore();
    store.grantLease("run_1", 1);
    store.openEpoch("ctx_1", 1, opening);
    store.attachRun("ctx_1", "run_1");
    const gateway = createFakeModelGateway([{ reply: value }, { reply: text("Shorter.") }], {
      store,
    });
    const sequence = store.append("ctx_1", { epoch: 1, purpose: "turn", input: null });
    const before = store.expectedPrefixDigest("ctx_1", 1, sequence);
    const first = await gateway.modelTurn(callOf(store, "ctx_1", "run_1", 1, sequence));
    assert.equal(first.outcome, expected, label);
    assert.equal(
      replyFit(value),
      { incomplete: "over_bound", invalid_output: "invalid" }[expected] ?? "fits",
      label,
    );
    assert.ok(validateCurrentDefinition("ModelResultV2", first), label);
    if (expected !== "incomplete") continue;
    // Booked like a cut and never kept: the resend names the same prefix, and the run goes on.
    assert.equal(first.message, null, label);
    assert.ok(first.usage, `${label}: booked`);
    store.recordOutcome("ctx_1", sequence, "incomplete");
    const resent = store.append("ctx_1", {
      epoch: 1,
      purpose: "turn",
      notices: [{ code: "output_cut", value: null }],
      input: null,
    });
    assert.equal(
      store.expectedPrefixDigest("ctx_1", 1, resent),
      before,
      `${label}: the cut reply is not in the prefix`,
    );
    const again = await gateway.modelTurn(callOf(store, "ctx_1", "run_1", 1, resent));
    assert.equal(again.outcome, "end_turn", `${label}: resent`);
  }
});
