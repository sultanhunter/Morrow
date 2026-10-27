// The replay runner, version 2 (ADR-0041; harness plan row H18): runs one case's recorded model
// outputs in the eval world, with every check in code, and returns the trace the scorer
// grades. Deterministic: no clock, randomness, network or model call. It stands in for the
// agent loop (H7), teammate calls (H10), Morrow's main thread (H11a) and memory (H12) until they
// land, so it checks what an arm makes the model do (which tools, in which turns, against which
// refusals, parks and compactions, with what taint), not the loop's durable steps, which their
// own tests and labs cover.
//
// The order of checks per call follows ADR-0027 item 2 as ADR-0041 amends it: the turn's 16
// running calls (extras `parallel_limit`), the offered tools (an unoffered name gets an error
// result and the model corrects it, item 8), the full input definition (`input_invalid`), the
// tool's code rules, the context's rules (`fork_first`, `hand_off_in_ask`,
// `checkpoint_not_requested`), ids in scope, authority, then the tool's own checks; a child's
// first hold the wallet cannot cover parks the whole job (item 9). Nothing ends a run early:
// check-ins and detectors park the job (item 18), and a run ends only as item 3 lists.
//
// A recording is model output bound to the inputs it was recorded on: it names its case, arm
// and the digest of the case's inputs, and each recorded call the outcome it met. When the
// world answers differently (a changed fixture or fake, or a hand edit), the recording is
// stale and the case is an error, never a pass or a fail.
import type { Current_AssistantModelMessage } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import type { ToolEntry } from "../tool-catalogue";
import { canonicalJson, recordingBasisDigest, sha256Hex } from "./canonical";
import type {
  EvalAgentRef,
  EvalArm,
  EvalCallOutcome,
  EvalCase,
  EvalEndCode,
  EvalEventCode,
  EvalFixture,
  EvalListingField,
  EvalRecordedCall,
  EvalRecordedRun,
  EvalRecordedTurn,
  EvalRecording,
  EvalRefusalCode,
  EvalTaintSource,
  EvalTeammateRef,
} from "./format";
import { fixtureText } from "./format";
import {
  evalArmRules,
  evalClaimsApproval,
  evalContextPolicy,
  evalEffort,
  evalInputValid,
  evalOfferedTools,
  evalSafetyProfile,
  evalWalletRules,
  microPerCredit,
  teammateByInstallationId,
  type EvalArmRules,
  type EvalRunKind,
  type EvalSafetyProfile,
  type EvalWalletRules,
} from "./world";

// --- The trace ----------------------------------------------------------------------------
export interface EvalEvent {
  readonly seq: number;
  readonly runKey: string;
  readonly code: EvalEventCode;
}
export interface EvalCallTrace {
  readonly id: string;
  readonly tool: string;
  readonly input: unknown;
  /** The step counter when the call was decided: orders calls against posts and replies. */
  readonly at: number;
  /** The code label of the call's result in its context (`c<n>`, ADR-0041 item 10). */
  readonly label: string;
  readonly outcome: EvalCallOutcome;
  readonly refusal: EvalRefusalCode | null;
  /** For agent.* calls: the teammate named, the call id code assigned, the child runs. */
  readonly target: EvalTeammateRef | null;
  readonly callId: string | null;
  readonly children: readonly string[];
}
export interface EvalTurnTrace {
  readonly turn: number;
  readonly kind: EvalRecordedTurn["kind"];
  readonly epoch: number;
  readonly cut: boolean;
  /**
   * The turn's text, a calling turn's included. Read by the scorer's hooks only; never copied
   * into a report.
   */
  readonly text: string | null;
  /** Every tool the reply named, dispatched or not. */
  readonly attemptedTools: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly calls: readonly EvalCallTrace[];
}
export interface EvalResultItem {
  readonly itemId: string;
  readonly kind: "table" | "text" | "file";
  readonly title: string;
  readonly pages: number;
}
export interface EvalFinding {
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  readonly recordIds: readonly string[];
}
/** A teammate's result as code builds it (TeammateResult@1, ADR-0041 items 19 and 23). */
export interface EvalTeammateResult {
  readonly callId: string;
  readonly runKeys: readonly string[];
  readonly agent: EvalTeammateRef;
  readonly mode: "ask" | "review" | "map";
  readonly outcome: string;
  readonly summary: string;
  readonly findings: readonly EvalFinding[];
  readonly verdicts: readonly string[];
  readonly items: readonly EvalResultItem[];
  readonly createdRecordIds: readonly string[];
  readonly readTags: readonly "customer"[];
  readonly tainted: boolean;
  readonly taintSources: readonly EvalTaintSource[];
}
export interface EvalRunTrace {
  readonly runKey: string;
  readonly agent: EvalAgentRef;
  readonly kind: EvalRunKind;
  readonly parent: string | null;
  readonly endCode: EvalEndCode;
  readonly turns: readonly EvalTurnTrace[];
  readonly tainted: boolean;
  readonly taintSources: readonly EvalTaintSource[];
  readonly readTags: readonly "customer"[];
  readonly creditsDrawn: number;
  /** A called run's last result (its latest follow-up's), or null. */
  readonly result: EvalTeammateResult | null;
}
export interface EvalProposalTrace {
  readonly proposalId: string;
  readonly kind: "catalog.listing" | "support.reply";
  readonly agent: EvalTeammateRef;
  readonly runKey: string;
  readonly at: number;
  readonly changes: readonly { readonly productId: string; readonly set: readonly EvalListingField[] }[];
  /** SHA-256 of the canonical proposal content; an approval binds this exact digest. */
  readonly digest: string;
  /** Nothing is applied: a person approves the exact digest first (ADR-0011). */
  readonly status: "awaiting_approval";
  readonly tainted: boolean;
}
export interface EvalCardTrace {
  readonly cardId: string;
  readonly runKey: string;
  readonly tainted: boolean;
}
/** Text a person sees: a conversation reply, a job's completion reply, or a post. */
export interface EvalReplyTrace {
  readonly runKey: string;
  readonly via: "conversation" | "complete" | "post";
  readonly at: number;
  readonly text: string;
}
/** Model-written text kept by the harness: a notebook entry, a memory suggestion, a summary. */
export interface EvalWrittenTrace {
  readonly runKey: string;
  readonly via: "notebook" | "memory_suggestion" | "result_summary" | "knowledge_proposal";
  readonly text: string;
  readonly tainted: boolean;
}
export interface EvalCompactionTrace {
  readonly runKey: string;
  readonly epoch: number;
  readonly strategy: "fallback" | "provider";
  /** False when code refused the summary (a claim) and rebased the epoch from SQL. */
  readonly accepted: boolean;
  readonly idsTouched: number;
  /** Ids touched so far that are in neither the summary, the kept tail nor the ledger. */
  readonly lost: readonly string[];
}
export interface EvalStale {
  readonly code: string;
  readonly where: string;
}
export interface EvalTrace {
  readonly caseId: string;
  readonly arm: EvalArm;
  readonly admission: "admitted" | EvalRefusalCode;
  readonly endCode: EvalEndCode;
  readonly runs: readonly EvalRunTrace[];
  readonly events: readonly EvalEvent[];
  readonly proposals: readonly EvalProposalTrace[];
  readonly cards: readonly EvalCardTrace[];
  readonly replies: readonly EvalReplyTrace[];
  readonly written: readonly EvalWrittenTrace[];
  readonly compactions: readonly EvalCompactionTrace[];
  /** Each post delivered, with the step counter at its delivery (orders it against calls). */
  readonly posts: readonly { readonly postId: string; readonly at: number }[];
  /** Refusals met outside a call's own outcome: a result refused at delivery. */
  readonly deliveryRefusals: readonly { readonly runKey: string; readonly code: EvalRefusalCode }[];
  readonly records: {
    readonly tasks: number;
    readonly suggestions: number;
    readonly reports: number;
    readonly posts: number;
    readonly notes: number;
  };
  /** Ids named in calls after a run's first compaction, and how many resolved exactly. */
  readonly exactIds: { readonly named: number; readonly resolved: number };
  /** Memory a run must never see that reached it anyway (another person's, tenant's, deleted). */
  readonly memoryLeaks: number;
  /** Store writes, messages to customers or any other effect outside Morrow: none may happen. */
  readonly externalEffects: number;
  readonly creditsDrawn: number;
  readonly creditsDrawnWhileParked: number;
  readonly stale: EvalStale | null;
}

// --- The engine ---------------------------------------------------------------------------
class StaleRecording extends Error {
  constructor(
    readonly code: string,
    readonly where: string,
  ) {
    super(code);
  }
}
type WaitKind = "credits" | "checkin" | "children" | "detector" | "question" | "approval";
/** The whole job parks: every run stops at its step boundary (ADR-0041 items 9 and 18). */
class Parked extends Error {
  constructor(readonly wait: WaitKind) {
    super("parked:" + wait);
  }
}
/** A person's Stop: every run of the job ends `stopped`. */
class Stopped extends Error {}

interface Item extends EvalResultItem {
  readonly taint: ReadonlySet<string>;
  open: boolean;
  owner: string;
  columns: number;
}
interface CallState {
  readonly callId: string;
  readonly mode: "ask" | "review" | "map" | "route";
  readonly target: EvalTeammateRef;
  readonly children: RunState[];
  state: "admitted" | "finished" | "cancelled" | "released";
  delivered: boolean;
  result: EvalTeammateResult | null;
  /** Taint of the items the result carries, for memory.read. */
  itemTaint: Set<string>;
}
interface PlanState {
  readonly items: Map<string, string>;
}
interface DetectorState {
  readonly signatures: string[];
  readonly sinceProgress: Map<string, number>;
  readonly seen: Set<string>;
  errorCode: string | null;
  errorStreak: number;
  idle: number;
  cuts: number;
  trip: "repeat" | "error_streak" | "idle" | "alternation" | "output_cut" | null;
}
interface RunState {
  readonly key: string;
  readonly agent: EvalAgentRef;
  readonly kind: EvalRunKind;
  readonly parent: string | null;
  readonly tools: ReadonlyMap<string, ToolEntry>;
  readonly turns: EvalTurnTrace[];
  readonly taint: Set<string>;
  readonly readTags: Set<"customer">;
  /** Ids the run may name: what it read, created or received, and its brief's. */
  readonly scope: Set<string>;
  /** Ids the run read from the world (store rows, pages, memory): the ledger does not hold these. */
  readonly touched: Set<string>;
  /** Result items received (Morrow) or written (a teammate). */
  readonly items: Map<string, Item>;
  readonly created: string[];
  readonly calls: Map<string, CallState>;
  readonly inbox: { taint: string[]; scope: string[] }[];
  readonly detector: DetectorState;
  index: number;
  epoch: number;
  labels: number;
  /** The label of each ok call (`c<n>` to whether it still passes). */
  readonly okLabels: Set<string>;
  plan: PlanState | null;
  openQuestion: boolean;
  preheldMicro: number;
  usedMicro: number;
  state: "running" | "idle" | "ended";
  endCode: EvalEndCode | null;
  creditsDrawn: number;
  result: EvalTeammateResult | null;
  /** The call that started or last reopened this child, for its result. */
  call: CallState | null;
  compactions: number;
  lastTurnTokens: number;
  lastTail: string;
}
type Decision = {
  outcome: EvalCallOutcome;
  refusal: EvalRefusalCode | null;
  target: EvalTeammateRef | null;
  callId: string | null;
  children: string[];
};
const refused = (code: EvalRefusalCode, target: EvalTeammateRef | null = null): Decision => ({
  outcome: code === "input_invalid" ? "invalid_input" : "refused",
  refusal: code,
  target,
  callId: null,
  children: [],
});
const ok = (
  target: EvalTeammateRef | null = null,
  callId: string | null = null,
  children: string[] = [],
): Decision => ({ outcome: "ok", refusal: null, target, callId, children });
const notRun = (): Decision => ({
  outcome: "not_run",
  refusal: null,
  target: null,
  callId: null,
  children: [],
});
const sourceOf = (fixture: EvalFixture): EvalTaintSource =>
  (
    ({
      product: "product",
      order_summary: "order_summary",
      inventory: "inventory",
      knowledge_page: "knowledge_page",
      support_thread: "support_mail",
      notebook_entry: "notebook_entry",
      person_memory: "person_memory",
      conversation_summary: "conversation_summary",
    }) as const
  )[fixture.kind];
const sorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort();
const taintSources = (taint: ReadonlySet<string>): EvalTaintSource[] =>
  sorted([...taint].map((entry) => entry.split(":")[0] as EvalTaintSource));
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Strings in a tool input that look like a world id (exact id replay, ADR-0041 item 37). */
const idLike =
  /^(?:product:[0-9]+|(?:thread|page|orders|stock|note|pmem|summary)_fake_[0-9]+|item_[A-Za-z0-9_-]+|call_[0-9]+)$/;
export function evalIdsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (idLike.test(value)) out.push(value);
  } else if (Array.isArray(value)) for (const entry of value) evalIdsIn(entry, out);
  else if (isObject(value)) for (const entry of Object.values(value)) evalIdsIn(entry, out);
  return out;
}
const recordIdsOf = (refs: unknown): string[] =>
  Array.isArray(refs)
    ? refs.flatMap((ref) => (isObject(ref) && typeof ref.id === "string" ? [ref.id] : []))
    : [];
/** Card tools (ADR-0037 item 5): never `agent.*`, `workspace.task.delegate` or human-only. */
const cardTools = new Set([
  "knowledge.search",
  "work.read",
  "products.read",
  "inventory.read",
  "orders.summary",
  "message.post",
  "task.create",
  "suggestion.create",
  "report.write",
  "proposal.listing",
  "notebook.write",
]);

class Replay {
  private readonly runs = new Map<string, RunState>();
  private readonly order: RunState[] = [];
  private readonly recorded = new Map<string, EvalRecordedRun>();
  private readonly consumed = new Set<string>();
  private readonly proposals: (Omit<EvalProposalTrace, "digest"> & { content: unknown })[] = [];
  private readonly cards: EvalCardTrace[] = [];
  private readonly replies: EvalReplyTrace[] = [];
  private readonly written: EvalWrittenTrace[] = [];
  private readonly compactionTraces: EvalCompactionTrace[] = [];
  private readonly deliveryRefusals: { runKey: string; code: EvalRefusalCode }[] = [];
  private readonly events: EvalEvent[] = [];
  private readonly records = { tasks: 0, suggestions: 0, reports: 0, posts: 0, notes: 0 };
  private readonly exactIds = { named: 0, resolved: 0 };
  private readonly pendingForks: RunState[] = [];
  private readonly deliveredPosts = new Set<string>();
  private readonly postSteps: { postId: string; at: number }[] = [];
  private readonly appliedStops = new Set<string>();
  private readonly wallet: { balance: number; used: number; held: number; topUps: number };
  private readonly job = {
    children: 0,
    calls: 0,
    modelTurns: 0,
    toolCalls: 0,
    turnBase: 0,
    callBase: 0,
    answers: 0,
  };
  private readonly rules: EvalArmRules;
  private step = 0;
  private memoryLeaks = 0;

  constructor(
    private readonly evalCase: EvalCase,
    private readonly recording: EvalRecording,
    private readonly arm: EvalArm,
    private readonly wallets: EvalWalletRules,
    private readonly safety: EvalSafetyProfile,
  ) {
    for (const run of recording.runs) this.recorded.set(run.runKey, run);
    this.wallet = {
      balance: evalCase.world.credits.balance * microPerCredit,
      used: 0,
      held: 0,
      topUps: 0,
    };
    this.rules = evalArmRules(arm);
  }

  private event(run: RunState, code: EvalEventCode) {
    this.events.push({ seq: this.events.length + 1, runKey: run.key, code });
  }
  private available() {
    return this.wallet.balance - this.wallet.used - this.wallet.held;
  }
  private holdMicro(agent: EvalAgentRef, turn: EvalRecordedTurn): number {
    const rates = this.wallets.microCreditsPerToken;
    return (
      turn.usage.inputTokens * rates.input +
      this.wallets.maxTokens[evalEffort(agent)] * rates.output
    );
  }
  /**
   * Holds `micro` from the wallet. When it cannot be covered, the whole job parks on credits;
   * a person's top-up resumes it, and nothing is drawn while it is parked (ADR-0041 item 9).
   */
  private hold(run: RunState, micro: number): boolean {
    while (this.available() < micro) {
      this.event(run, "park:credits");
      const topUp = this.evalCase.world.credits.topUps[this.wallet.topUps];
      if (topUp === undefined) return false;
      this.wallet.topUps += 1;
      this.wallet.balance += topUp * microPerCredit;
      this.event(run, "resume:credits");
    }
    this.wallet.held += micro;
    return true;
  }

  // --- Admission ----------------------------------------------------------------------------
  private newRun(
    key: string,
    agent: EvalAgentRef,
    kind: EvalRunKind,
    parent: RunState | null,
  ): RunState {
    const recorded = this.recorded.get(key);
    if (!recorded) throw new StaleRecording("run_missing", key);
    if (recorded.agent !== agent) throw new StaleRecording("run_agent", key);
    // Each recorded run starts once: a second start would replay it again.
    if (this.runs.has(key)) throw new StaleRecording("child_reused", key);
    this.consumed.add(key);
    const state: RunState = {
      key,
      agent,
      kind,
      parent: parent?.key ?? null,
      tools: evalOfferedTools(agent, kind, this.arm),
      turns: [],
      taint: new Set(),
      readTags: new Set(),
      scope: new Set(),
      touched: new Set(),
      items: new Map(),
      created: [],
      calls: new Map(),
      inbox: [],
      detector: {
        signatures: [],
        sinceProgress: new Map(),
        seen: new Set(),
        errorCode: null,
        errorStreak: 0,
        idle: 0,
        cuts: 0,
        trip: null,
      },
      index: 0,
      epoch: 1,
      labels: 0,
      okLabels: new Set(),
      plan: null,
      openQuestion: false,
      preheldMicro: 0,
      usedMicro: 0,
      state: "running",
      endCode: null,
      creditsDrawn: 0,
      result: null,
      call: null,
      compactions: 0,
      lastTurnTokens: 0,
      lastTail: "",
    };
    this.runs.set(key, state);
    this.order.push(state);
    return state;
  }

  async replay(): Promise<EvalTrace> {
    let stale: EvalStale | null = null;
    let admission: "admitted" | EvalRefusalCode = "admitted";
    try {
      if (this.recording.caseId !== this.evalCase.caseId)
        throw new StaleRecording("case_mismatch", "recording");
      if (this.recording.arm !== this.arm) throw new StaleRecording("arm_mismatch", "recording");
      if (this.recording.basisDigest !== (await recordingBasisDigest(this.evalCase)))
        throw new StaleRecording("basis_mismatch", "recording");
      const entry = this.evalCase.entry;
      const world = this.evalCase.world;
      // A teammate the person asks directly must be active and unpaused (admission, in code).
      if (
        entry.agent !== "morrow" &&
        (world.paused.includes(entry.agent) || !world.activeTeammates.includes(entry.agent))
      )
        admission = "teammate_unavailable";
      if (admission !== "admitted") {
        this.consumed.add("root");
        if ((this.recorded.get("root")?.turns.length ?? 0) !== 0)
          throw new StaleRecording("turns_left", "root");
        if (this.recorded.get("root")?.agent !== entry.agent)
          throw new StaleRecording("run_agent", "root");
      } else {
        const kind: EvalRunKind =
          entry.agent === "morrow" ? (entry.purpose === "conversation" ? "conversation" : "job") : "routed";
        const root = this.newRun("root", entry.agent, kind, null);
        this.opening(root);
        this.drive(root);
      }
      for (const key of this.recorded.keys())
        if (!this.consumed.has(key)) throw new StaleRecording("run_unused", key);
      for (const run of this.order)
        if (run.index !== this.recorded.get(run.key)!.turns.length)
          throw new StaleRecording("turns_left", run.key + "#" + (run.index + 1));
      for (const post of world.posts)
        if (!this.deliveredPosts.has(post.postId))
          throw new StaleRecording("post_undelivered", post.postId);
      for (const stop of world.stops)
        if (!this.appliedStops.has(stop.run + "#" + stop.beforeTurn))
          throw new StaleRecording("stop_unapplied", stop.run);
    } catch (error) {
      if (!(error instanceof StaleRecording)) throw error;
      stale = { code: error.code, where: error.where };
    }
    // Memory no run may see (another person's, another tenant's, deleted) that reached one.
    for (const f of this.evalCase.fixtures)
      if (
        f.memory &&
        (f.memory.tenant !== "this" || f.memory.deleted || f.memory.audience === "other_person")
      )
        for (const run of this.order) if (run.touched.has(f.recordId)) this.memoryLeaks += 1;
    const proposals: EvalProposalTrace[] = [];
    for (const { content, ...draft } of this.proposals)
      proposals.push({ ...draft, digest: await sha256Hex(canonicalJson(content)) });
    const runs = this.order.map((run) => this.runTrace(run));
    const root = runs.find((run) => run.runKey === "root");
    return {
      caseId: this.evalCase.caseId,
      arm: this.arm,
      admission,
      endCode: admission === "admitted" ? (root?.endCode ?? "internal_error") : "not_admitted",
      runs,
      events: this.events,
      proposals,
      cards: this.cards,
      replies: this.replies,
      written: this.written,
      compactions: this.compactionTraces,
      posts: this.postSteps,
      deliveryRefusals: this.deliveryRefusals,
      records: { ...this.records },
      exactIds: { ...this.exactIds },
      memoryLeaks: this.memoryLeaks,
      externalEffects: 0,
      creditsDrawn: runs.reduce((sum, run) => sum + run.creditsDrawn, 0),
      creditsDrawnWhileParked: 0,
      stale,
    };
  }

  /**
   * The opening code renders (ADR-0041 items 12 and 29): the requester's standing person
   * memories, within their budget, as the person's own confirmed words (no taint).
   */
  private opening(run: RunState) {
    for (const f of this.evalCase.fixtures)
      if (f.kind === "person_memory" && f.memory!.standing && this.memoryReadable(run, f)) {
        run.scope.add(f.recordId);
        run.touched.add(f.recordId);
        if (f.memory!.tainted) run.taint.add("person_memory:" + f.recordId);
      }
  }

  /** Runs the root, then each fork of Morrow's main thread, until the job ends or waits. */
  private drive(root: RunState) {
    try {
      this.loop(root);
      while (this.pendingForks.length) this.loop(this.pendingForks.shift()!);
    } catch (error) {
      if (error instanceof Parked) {
        for (const run of this.order) if (run.state === "running") this.settle(run, "parked");
      } else if (error instanceof Stopped) {
        for (const run of this.order) if (run.state === "running") this.settle(run, "stopped");
      } else throw error;
    }
    // Idle children close as released when their job ends; their result stands.
    for (const run of this.order) if (run.state === "idle") run.state = "ended";
  }

  private runTrace(run: RunState): EvalRunTrace {
    return {
      runKey: run.key,
      agent: run.agent,
      kind: run.kind,
      parent: run.parent,
      endCode: run.endCode ?? "internal_error",
      turns: run.turns,
      tainted: run.taint.size > 0,
      taintSources: taintSources(run.taint),
      readTags: sorted(run.readTags),
      creditsDrawn: run.creditsDrawn,
      result: run.result,
    };
  }

  /** Ends a run: settles its credits (a failed ending caused by Morrow is refunded). */
  private settle(run: RunState, code: EvalEndCode) {
    run.state = code === "completed" && (run.kind === "call" || run.kind === "review") ? "idle" : "ended";
    run.endCode = code;
    this.wallet.held -= run.preheldMicro;
    run.preheldMicro = 0;
    if (code === "internal_error") {
      this.wallet.used -= run.usedMicro;
      run.creditsDrawn = 0;
      return;
    }
    run.creditsDrawn = Math.ceil(run.usedMicro / microPerCredit);
  }

  // --- The loop ---------------------------------------------------------------------------
  private loop(run: RunState): void {
    const recorded = this.recorded.get(run.key)!;
    for (;;) {
      if (run.state !== "running") return;
      this.boundary(run);
      const turn = recorded.turns[run.index];
      if (!turn) throw new StaleRecording("turn_missing", run.key + "#" + (run.index + 1));
      this.checkIns(run);
      // Compaction is due before a send when the last ordinary turn reached the threshold.
      const threshold =
        this.evalCase.world.context.compactAt ??
        evalContextPolicy.workingWindow * evalContextPolicy.compactAtShare;
      const due = run.lastTurnTokens >= threshold;
      if (due !== (turn.kind !== "turn"))
        throw new StaleRecording(
          due ? "compaction_missing" : "compaction_unexpected",
          run.key + "#" + (run.index + 1),
        );
      const strategy = this.evalCase.world.context.strategy;
      if (due && (turn.kind === "checkpoint") !== (strategy === "fallback"))
        throw new StaleRecording("compaction_strategy", run.key + "#" + (run.index + 1));
      // The hold before the send: a child's first hold was taken at admission.
      const need = this.holdMicro(run.agent, turn);
      if (run.preheldMicro >= need) {
        this.wallet.held -= run.preheldMicro - need;
        run.preheldMicro = 0;
      } else {
        this.wallet.held -= run.preheldMicro;
        run.preheldMicro = 0;
        if (!this.hold(run, need)) throw new Parked("credits");
      }
      run.index += 1;
      this.job.modelTurns += 1;
      const rates = this.wallets.microCreditsPerToken;
      const metered = turn.usage.inputTokens * rates.input + turn.usage.outputTokens * rates.output;
      this.wallet.held -= need;
      this.wallet.used += metered;
      run.usedMicro += metered;
      const calls: EvalCallTrace[] = [];
      run.turns.push({
        turn: run.index,
        kind: turn.kind,
        epoch: run.epoch,
        cut: turn.cut,
        text: turn.text,
        attemptedTools: turn.cut ? [] : turn.calls.map((call) => call.tool),
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        calls,
      });
      if (metered > need) {
        // A booking above any possible worst case: booked, never dropped, and the run ends.
        this.settle(run, "cost_budget");
        return;
      }
      if (turn.kind !== "turn") {
        this.compact(run, turn, calls);
        continue;
      }
      run.lastTurnTokens = turn.usage.inputTokens + turn.usage.outputTokens;
      if (turn.cut) {
        // Cut at max_tokens: booked, never sent back as history; resent with output_cut.
        this.event(run, "output_cut:max_tokens");
        run.detector.cuts += 1;
        if (run.detector.cuts >= this.safety.detectors.outputCuts) this.trip(run, "output_cut");
        continue;
      }
      if (!this.protocolValid(turn)) {
        this.settle(run, "internal_error");
        return;
      }
      run.lastTail = canonicalJson({ text: turn.text, calls: turn.calls.map((c) => c.input) });
      if (turn.calls.length === 0) this.textOnly(run, turn.text ?? "");
      else this.dispatchTurn(run, turn.calls, calls);
      if (run.detector.trip) this.trip(run, run.detector.trip);
    }
  }

  /**
   * A protocol break ends the run, free (item 8): a reply outside the message's frame (more
   * blocks than it holds, or a text block outside its shape). An invalid or unoffered tool_use
   * is not one: it gets an error result and the model corrects it.
   */
  private protocolValid(turn: EvalRecordedTurn): boolean {
    const blocks = turn.calls.length + (turn.text === null ? 0 : 1);
    if (blocks < 1 || blocks > 32) return false;
    if (turn.text === null) return true;
    const content: Current_AssistantModelMessage["content"][number][] = [
      { type: "text", text: turn.text },
    ];
    return validateCurrentDefinition("AssistantModelMessage", { role: "assistant", content });
  }

  /** What reaches a run at its turn boundary: stops, posts, results, guidance. */
  private boundary(run: RunState) {
    const world = this.evalCase.world;
    const at = run.index + 1;
    if (world.stops.some((stop) => stop.run === run.key && stop.beforeTurn === at)) {
      this.appliedStops.add(run.key + "#" + at);
      this.event(run, "stop:person");
      throw new Stopped();
    }
    for (const post of world.posts)
      if (post.run === run.key && post.beforeTurn === at && !this.deliveredPosts.has(post.postId)) {
        this.deliveredPosts.add(post.postId);
        this.step += 1;
        this.postSteps.push({ postId: post.postId, at: this.step });
        if (post.from === "requester") {
          // The requester's own words: they steer, reset the stall counters, never taint.
          this.event(run, "post:requester");
          this.progress(run);
          run.scope.add(post.postId);
        } else {
          // Another member's post is data with `other_member` taint, never steering.
          this.event(run, "post:other_member");
          run.taint.add("other_member:" + post.postId);
        }
      }
    for (const call of run.calls.values())
      if (call.state === "finished" && !call.delivered && this.rules.asyncCalls) this.deliver(run, call);
    for (const message of run.inbox.splice(0)) {
      for (const entry of message.taint) run.taint.add(entry);
      for (const id of message.scope) run.scope.add(id);
    }
  }

  /** A finished call's result reaches Morrow's run as wrapped data (ADR-0041 item 21). */
  private deliver(run: RunState, call: CallState) {
    call.delivered = true;
    const result = call.result!;
    // ADR-0037 item 3(a): a result with a customer read tag never enters Morrow's context.
    if (result.readTags.includes("customer")) {
      this.event(run, "result:customer_tagged");
      this.deliveryRefusals.push({ runKey: run.key, code: "result_customer_tagged" });
      return;
    }
    this.event(run, "result:delivered");
    this.progress(run);
    run.taint.add("teammate_result:" + call.callId);
    for (const entry of call.itemTaint) run.taint.add(entry);
    run.scope.add(call.callId);
    for (const id of result.createdRecordIds) run.scope.add(id);
    for (const finding of result.findings) for (const id of finding.recordIds) run.scope.add(id);
    for (const item of result.items) {
      run.scope.add(item.itemId);
      run.items.set(item.itemId, {
        ...item,
        taint: new Set([...call.itemTaint, "result_item:" + item.itemId]),
        open: false,
        owner: call.callId,
        columns: 0,
      });
    }
  }

  // --- Check-ins and detectors (ADR-0041 item 18) ------------------------------------------
  private checkIns(run: RunState) {
    const c = this.safety.checkIns;
    const turns = this.job.modelTurns - this.job.turnBase >= c.modelTurns;
    const calls = this.job.toolCalls - this.job.callBase >= c.toolCalls;
    if (!turns && !calls) return;
    this.event(run, turns ? "checkin:model_turns" : "checkin:tool_calls");
    this.event(run, "park:checkin");
    if (this.evalCase.world.atCheckIn !== "continue") throw new Parked("checkin");
    // Continue: the requester's act issues a new allotment within a successor envelope.
    this.job.turnBase = this.job.modelTurns;
    this.job.callBase = this.job.toolCalls;
    this.event(run, "resume:checkin");
  }
  private trip(run: RunState, code: NonNullable<DetectorState["trip"]>) {
    run.detector.trip = null;
    this.event(run, ("detector_trip:" + code) as EvalEventCode);
    this.event(run, "park:detector");
    if (this.evalCase.world.atCheckIn !== "continue") throw new Parked("detector");
    this.event(run, "resume:detector");
    this.progress(run);
    run.detector.cuts = 0;
    run.detector.idle = 0;
    run.detector.errorStreak = 0;
  }
  private progress(run: RunState) {
    run.detector.sinceProgress.clear();
    run.detector.errorStreak = 0;
    run.detector.errorCode = null;
    run.detector.idle = 0;
  }
  private observe(run: RunState, call: EvalRecordedCall, decision: Decision) {
    const d = run.detector;
    const signature = call.tool + "|" + canonicalJson(call.input ?? null) + "|" + decision.outcome + "|" + (decision.refusal ?? "");
    d.signatures.push(signature);
    if (d.signatures.length > 32) d.signatures.shift();
    const count = (d.sinceProgress.get(signature) ?? 0) + 1;
    d.sinceProgress.set(signature, count);
    const fresh = !d.seen.has(signature);
    d.seen.add(signature);
    if (decision.outcome === "ok" && fresh) {
      // A new result is progress: the repeat counts restart (a ring of signatures since it).
      d.sinceProgress.clear();
      d.sinceProgress.set(signature, 1);
    }
    const repeat = this.safety.detectors.repeat;
    if (count === repeat.nudge) this.event(run, "detector_nudge:repeat");
    if (count >= repeat.trip) d.trip ??= "repeat";
    if (decision.refusal !== null) {
      d.errorStreak = d.errorCode === decision.refusal ? d.errorStreak + 1 : 1;
      d.errorCode = decision.refusal;
      const streak = this.safety.detectors.errorStreak;
      if (d.errorStreak === streak.nudge) this.event(run, "detector_nudge:error_streak");
      if (d.errorStreak >= streak.trip) d.trip ??= "error_streak";
    } else {
      d.errorStreak = 0;
      d.errorCode = null;
    }
    const n = this.safety.detectors.alternationSteps;
    const last = d.signatures.slice(-n);
    if (
      last.length === n &&
      last[0] !== last[1] &&
      last.every((s, i) => s === last[i % 2])
    )
      d.trip ??= "alternation";
  }

  // --- Context (ADR-0041 items 11 and 13) ---------------------------------------------------
  private ledgerIds(run: RunState): Set<string> {
    const ids = new Set<string>([...run.created, ...run.items.keys(), ...run.calls.keys()]);
    for (const proposal of this.proposals) if (proposal.runKey === run.key) ids.add(proposal.proposalId);
    return ids;
  }
  private compact(run: RunState, turn: EvalRecordedTurn, calls: EvalCallTrace[]) {
    const strategy = this.evalCase.world.context.strategy;
    let summary: string;
    let accepted: boolean;
    if (turn.kind === "checkpoint") {
      const call = turn.calls[0]!;
      const valid = evalInputValid("context.checkpoint", call.input);
      summary = canonicalJson(call.input ?? null);
      accepted = valid && !evalClaimsApproval(summary);
      const decision: Decision = valid
        ? accepted
          ? ok()
          : refused("verification_failed")
        : refused("input_invalid");
      run.labels += 1;
      calls.push(this.callTrace(run, call, decision));
      this.checkExpected(run, call, decision);
    } else {
      summary = turn.text ?? "";
      accepted = !evalClaimsApproval(summary);
    }
    run.epoch += 1;
    run.compactions += 1;
    let lost: string[] = [];
    if (accepted) {
      this.event(run, strategy === "fallback" ? "compaction:fallback" : "compaction:provider");
      // Every id the job touched must survive: in the summary, the kept tail (the provider
      // strategy keeps one) or the ledger code renders from SQL (item 13).
      const ledger = this.ledgerIds(run);
      const tail = strategy === "provider" ? run.lastTail : "";
      lost = [...run.touched].filter(
        (id) => !ledger.has(id) && !summary.includes(id) && !tail.includes(id),
      );
    } else {
      // Code refuses a summary that claims an approval; the epoch is rebuilt from SQL alone,
      // with pointers to older turns that memory.read can reopen (item 11, step 4).
      this.event(run, "checkpoint_refused:claim");
      this.event(run, "rebase:sql");
    }
    this.compactionTraces.push({
      runKey: run.key,
      epoch: run.epoch,
      strategy,
      accepted,
      idsTouched: run.touched.size,
      lost: lost.sort(),
    });
    run.lastTurnTokens = 0;
  }

  // --- Turns ----------------------------------------------------------------------------
  private reply(run: RunState, via: EvalReplyTrace["via"], text: string) {
    this.step += 1;
    this.replies.push({ runKey: run.key, via, at: this.step, text });
  }
  private openCalls(run: RunState) {
    return [...run.calls.values()].filter((c) => c.state === "admitted");
  }
  private textOnly(run: RunState, text: string) {
    if (run.kind === "conversation") {
      // In a conversation a reply with no tool call means "reply and wait for the person".
      this.reply(run, "conversation", text);
      this.settle(run, "completed");
      return;
    }
    if (run.kind === "job" && this.openCalls(run).length > 0) {
      // A text-only turn while children are open is an implicit wait for any child.
      this.runChildren(run);
      return;
    }
    // Otherwise an idle turn in a job or call: three in a row trip a detector.
    run.detector.idle += 1;
    if (run.detector.idle >= this.safety.detectors.idleTurns) run.detector.trip ??= "idle";
  }
  private callTrace(run: RunState, call: EvalRecordedCall, decision: Decision): EvalCallTrace {
    this.step += 1;
    return {
      id: call.id,
      tool: call.tool,
      input: call.input,
      at: this.step,
      label: "c" + run.labels,
      outcome: decision.outcome,
      refusal: decision.refusal,
      target: decision.target,
      callId: decision.callId,
      children: decision.children,
    };
  }
  private checkExpected(run: RunState, call: EvalRecordedCall, decision: Decision) {
    if (
      decision.outcome !== call.expect.outcome ||
      decision.refusal !== call.expect.refusal ||
      decision.children.join() !== call.expect.children.join()
    )
      throw new StaleRecording("call_outcome", run.key + ":" + call.id);
  }

  /** Per turn: a park the turn's calls asked for, and whether they asked to wait for children. */
  private readonly turnStack: { parkAfter: WaitKind | null; waitAfter: boolean }[] = [];
  private get parkAfter(): WaitKind | null {
    return this.turnStack.at(-1)!.parkAfter;
  }
  private set parkAfter(value: WaitKind | null) {
    this.turnStack.at(-1)!.parkAfter = value;
  }
  private set waitAfter(value: boolean) {
    this.turnStack.at(-1)!.waitAfter = value;
  }
  private dispatchTurn(run: RunState, calls: readonly EvalRecordedCall[], out: EvalCallTrace[]) {
    const state = { parkAfter: null as WaitKind | null, waitAfter: false };
    this.turnStack.push(state);
    try {
      this.dispatchCalls(run, calls, out, state);
    } finally {
      this.turnStack.pop();
    }
  }
  private dispatchCalls(
    run: RunState,
    calls: readonly EvalRecordedCall[],
    out: EvalCallTrace[],
    state: { parkAfter: WaitKind | null; waitAfter: boolean },
  ) {
    const deferred: RunState[] = [];
    let asked = false;
    calls.forEach((call, index) => {
      let decision: Decision;
      if (this.parkAfter !== null || run.state !== "running") decision = notRun();
      else if (index >= this.safety.toolCallsPerTurn) decision = refused("parallel_limit");
      else {
        this.job.toolCalls += 1;
        decision = this.decide(run, call, deferred);
        if (call.tool === "inbox.ask" && decision.outcome === "ok") asked = true;
      }
      if (decision.outcome !== "not_run") {
        run.labels += 1;
        if (decision.outcome === "ok") run.okLabels.add("c" + run.labels);
      }
      const trace = this.callTrace(run, call, decision);
      out.push(trace);
      this.checkExpected(run, call, decision);
      if (decision.outcome !== "not_run") this.observe(run, call, decision);
      // Exact id replay: ids named after the run's first compaction resolve exactly.
      if (run.compactions > 0 && this.evalCase.probes.exactIds) {
        const known = this.knownIds();
        for (const id of evalIdsIn(call.input)) {
          this.exactIds.named += 1;
          if (known.has(id)) this.exactIds.resolved += 1;
        }
      }
    });
    // The turn's own requests, read before any child runs (a child has its own turns).
    const parkAfter = state.parkAfter;
    const waitAfter = state.waitAfter;
    if (parkAfter !== null) throw new Parked(parkAfter);
    // Hand-offs run once the turn's calls are decided; Morrow gets nothing back from them.
    for (const child of deferred) this.loop(child);
    if (asked) this.awaitAnswer(run);
    if (waitAfter && run.state === "running") this.runChildren(run);
  }
  /** A question waits for the requester's answer; one left unanswered parks the job. */
  private awaitAnswer(run: RunState) {
    this.event(run, "park:question");
    const answer = this.evalCase.world.answers[this.job.answers];
    if (answer === undefined) throw new Parked("question");
    this.job.answers += 1;
    run.openQuestion = false;
    this.event(run, "answer:requester");
    this.event(run, "resume:question");
    this.progress(run);
  }
  private knownIds(): Set<string> {
    const ids = new Set<string>();
    for (const f of this.evalCase.fixtures) {
      ids.add(f.recordId);
      if (f.kind === "order_summary" || f.kind === "inventory")
        for (const row of f.data.rows) ids.add(row.recordId);
    }
    for (const run of this.order) {
      for (const id of run.created) ids.add(id);
      for (const id of run.items.keys()) ids.add(id);
      for (const id of run.calls.keys()) ids.add(id);
    }
    return ids;
  }

  /** Runs every open call of `run` to its result, in admission order (an explicit wait). */
  private runChildren(run: RunState) {
    for (const call of this.openCalls(run)) this.runCall(run, call);
  }
  private runCall(_run: RunState, call: CallState) {
    for (const child of call.children) if (child.state === "running") this.loop(child);
    if (call.children.some((child) => child.state === "running")) return;
    call.state = "finished";
    call.result = this.buildResult(call);
    if (call.mode === "map") this.event(call.children[0]!, "map:merged");
  }

  private buildResult(call: CallState): EvalTeammateResult {
    const parts = call.children.map((child) => child.result);
    const taint = new Set<string>();
    const readTags = new Set<"customer">();
    for (const child of call.children) {
      for (const entry of child.taint) taint.add(entry);
      for (const tag of child.readTags) readTags.add(tag);
    }
    call.itemTaint = taint;
    const items =
      call.mode === "map"
        ? [
            {
              itemId: "item_map_" + call.callId,
              kind: "table" as const,
              title: "Merged results",
              pages: Math.max(1, parts.reduce((n, p) => n + (p?.items.length ?? 0), 0)),
            },
          ]
        : (parts[0]?.items ?? []);
    // A run that ended without run.complete is partial when it created records or items,
    // otherwise no_result; code builds that result from SQL (ADR-0041 item 23).
    const outcomes = call.children.map(
      (child) => child.result?.outcome ?? (child.created.length > 0 ? "partial" : "no_result"),
    );
    return {
      callId: call.callId,
      runKeys: call.children.map((child) => child.key),
      agent: call.target,
      mode: call.mode === "review" ? "review" : call.mode === "map" ? "map" : "ask",
      outcome:
        call.mode === "map"
          ? outcomes.every((o) => o === "done")
            ? "done"
            : "partial"
          : outcomes[0]!,
      summary: parts.map((p) => p?.summary ?? "").join("\n"),
      findings: parts.flatMap((p) => p?.findings ?? []),
      verdicts: parts.flatMap((p) => p?.verdicts ?? []),
      items,
      createdRecordIds: call.children.flatMap((child) => child.created),
      readTags: sorted(readTags),
      tainted: taint.size > 0,
      taintSources: taintSources(taint),
    };
  }

  // --- Calls ----------------------------------------------------------------------------
  private admitChild(
    parent: RunState,
    key: string,
    agent: EvalTeammateRef,
    kind: EvalRunKind,
    records: readonly string[],
  ): RunState | "parked" {
    // The kernel's children per envelope: the 33rd checks the job in (ADR-0041 item 21).
    if (this.job.children >= this.safety.checkIns.children) {
      this.event(parent, "checkin:children");
      this.event(parent, "park:children");
      if (this.evalCase.world.atCheckIn !== "continue") return "parked";
      this.job.children = 0;
      this.event(parent, "resume:children");
    }
    const recorded = this.recorded.get(key);
    if (!recorded) throw new StaleRecording("run_missing", key);
    // The child's first hold, taken at admission; one the wallet cannot cover parks the job.
    const first = recorded.turns[0];
    const need = first ? this.holdMicro(agent, first) : 0;
    if (!this.hold(parent, need)) return "parked";
    const child = this.newRun(key, agent, kind, parent);
    child.preheldMicro = need;
    this.job.children += 1;
    // The parent's taint carries into the brief; the brief's records are in scope.
    for (const entry of parent.taint) child.taint.add(entry);
    for (const id of records) {
      child.scope.add(id);
      for (const entry of parent.items.get(id)?.taint ?? []) child.taint.add(entry);
    }
    return child;
  }

  private decide(run: RunState, call: EvalRecordedCall, deferred: RunState[]): Decision {
    const spec = run.tools.get(call.tool);
    if (!spec) return refused("not_offered");
    if (!evalInputValid(spec.name, call.input)) return refused("input_invalid");
    const input = call.input as Record<string, unknown>;
    const world = this.evalCase.world;
    const authorized = () =>
      spec.capabilityId === null || !world.requesterLacks.includes(spec.capabilityId);
    const fixtures = this.evalCase.fixtures;
    const read = (f: EvalFixture) => {
      run.scope.add(f.recordId);
      run.touched.add(f.recordId);
      // Store rows and pages are untrusted; a person's confirmed memory is the person's words.
      if (!(f.kind === "person_memory" && !f.memory!.tainted))
        run.taint.add(sourceOf(f) + ":" + f.recordId);
    };
    const morrowJob = run.agent === "morrow" && run.kind === "job";
    switch (spec.name) {
      case "products.read": {
        if (!authorized()) return refused("authority_denied");
        const ids = input.productIds as string[] | null;
        const title = (input.titleContains as string | null)?.toLowerCase() ?? null;
        const found = fixtures
          .filter((f) => f.kind === "product")
          .filter((f) => ids === null || ids.includes(f.recordId))
          .filter((f) => title === null || (f.kind === "product" && f.data.title.toLowerCase().includes(title)))
          .slice(0, input.limit as number);
        for (const f of found) read(f);
        return ok();
      }
      case "inventory.read":
      case "orders.summary": {
        if (!authorized()) return refused("authority_denied");
        const kind = spec.name === "inventory.read" ? "inventory" : "order_summary";
        for (const f of fixtures) {
          if (f.kind !== kind) continue;
          if (f.kind === "order_summary" && f.data.metric !== input.metric) continue;
          read(f);
          if (f.kind === "inventory" || f.kind === "order_summary")
            for (const row of f.data.rows) {
              if (f.kind === "inventory" && !(input.productIds as string[]).includes(row.recordId))
                continue;
              run.scope.add(row.recordId);
              run.touched.add(row.recordId);
            }
        }
        return ok();
      }
      case "support.thread.read": {
        const thread = fixtures.find((f) => f.kind === "support_thread" && f.recordId === input.threadId);
        if (!thread || !run.scope.has(thread.recordId)) return refused("id_out_of_scope");
        if (!authorized()) return refused("authority_denied");
        read(thread);
        run.readTags.add("customer");
        return ok();
      }
      case "knowledge.search": {
        if (!authorized()) return refused("authority_denied");
        const needle = (input.searchText as string).toLowerCase();
        const found = fixtures
          .filter((f) => f.kind === "knowledge_page")
          .filter((f) => matches(fixtureText(f), [needle]))
          .slice(0, input.limit as number);
        for (const f of found) read(f);
        return ok();
      }
      case "memory.search": {
        const layers = input.layers as string[];
        const queries = (input.queries as string[]).map((q) => q.toLowerCase());
        const layerOf: Partial<Record<EvalFixture["kind"], string>> = {
          knowledge_page: "knowledge",
          notebook_entry: "notebook",
          person_memory: "person_memory",
          conversation_summary: "conversation",
        };
        const hits = fixtures
          .filter((f) => layerOf[f.kind] && (layers.length === 0 || layers.includes(layerOf[f.kind]!)))
          .filter((f) => matches(fixtureText(f), queries))
          .filter((f) => this.memoryReadable(run, f))
          .slice(0, input.limit as number);
        for (const f of hits) read(f);
        return ok();
      }
      case "memory.read":
        return this.memoryRead(run, input, read);
      case "work.read": {
        if (input.id !== null && !run.scope.has(input.id as string)) return refused("id_out_of_scope");
        return authorized() ? ok() : refused("authority_denied");
      }
      case "message.post":
      case "task.create":
      case "suggestion.create":
      case "report.write":
      case "plan.draft": {
        if (!authorized()) return refused("authority_denied");
        if (spec.name === "message.post") {
          this.records.posts += 1;
          this.reply(run, "post", input.body as string);
        } else if (spec.name === "task.create") {
          this.records.tasks += 1;
          run.created.push("task_" + run.key + "_" + this.records.tasks);
        } else if (spec.name === "suggestion.create") {
          this.records.suggestions += 1;
          run.created.push("suggestion_" + run.key + "_" + this.records.suggestions);
        } else if (spec.name === "report.write") {
          this.records.reports += 1;
          run.created.push("report_" + run.key + "_" + this.records.reports);
        } else run.created.push("plandraft_" + run.key + "_" + (run.created.length + 1));
        return ok();
      }
      case "inbox.ask": {
        if (run.openQuestion) return refused("question_limit");
        if (!authorized()) return refused("authority_denied");
        run.openQuestion = true;
        return ok();
      }
      case "notebook.write":
      case "memory.suggest":
      case "knowledge.propose": {
        if (!authorized()) return refused("authority_denied");
        const text = spec.name === "notebook.write" ? (input.text as string) : (input.text as string);
        const via =
          spec.name === "notebook.write"
            ? "notebook"
            : spec.name === "memory.suggest"
              ? "memory_suggestion"
              : "knowledge_proposal";
        // What a run writes keeps its taint (taint is sticky and follows lineage, item 25).
        this.written.push({ runKey: run.key, via, text, tainted: run.taint.size > 0 });
        if (via === "notebook") this.records.notes += 1;
        run.created.push(via + "_" + run.key + "_" + this.written.length);
        return ok();
      }
      case "proposal.listing": {
        const changes = input.changes as Record<string, unknown>[];
        if (changes.some((change) => !run.scope.has(change.productId as string)))
          return refused("id_out_of_scope");
        if (!authorized()) return refused("authority_denied");
        const proposalId = "proposal_" + run.key + "_" + (this.proposals.length + 1);
        run.created.push(proposalId);
        this.step += 1;
        this.proposals.push({
          proposalId,
          kind: "catalog.listing",
          agent: run.agent as EvalTeammateRef,
          runKey: run.key,
          at: this.step,
          changes: changes.map((change) => ({
            productId: change.productId as string,
            set: (["title", "descriptionHtml", "seo", "tags"] as const).filter((f) => change[f] !== null),
          })),
          status: "awaiting_approval",
          tainted: run.taint.size > 0,
          content: { proposalId, kind: "catalog.listing", agent: run.agent, changes },
        });
        return ok();
      }
      case "proposal.reply": {
        if (!run.scope.has(input.threadId as string)) return refused("id_out_of_scope");
        if (!authorized()) return refused("authority_denied");
        const proposalId = "proposal_" + run.key + "_" + (this.proposals.length + 1);
        run.created.push(proposalId);
        this.step += 1;
        this.proposals.push({
          proposalId,
          kind: "support.reply",
          agent: run.agent as EvalTeammateRef,
          runKey: run.key,
          at: this.step,
          changes: [],
          status: "awaiting_approval",
          tainted: run.taint.size > 0,
          content: { proposalId, kind: "support.reply", agent: run.agent, input },
        });
        return ok();
      }
      case "context.checkpoint":
        // Accepted only inside a checkpoint fork, which the loop opens (a `checkpoint` turn).
        return refused("checkpoint_not_requested");
      case "run.plan":
        return this.runPlan(run, input);
      case "run.wait": {
        if (input.kind !== "children") {
          // A wait for proposals or a time: nobody decides or waits in the replay, so it parks.
          if (input.kind === "proposals") {
            this.parkAfter = "approval";
            this.event(run, "park:approval");
          }
          return ok();
        }
        const ids = input.callIds as string[] | null;
        if (ids && ids.some((id) => !run.calls.has(id))) return refused("call_not_found");
        this.waitAfter = true;
        return ok();
      }
      case "result.write":
        return this.resultWrite(run, input);
      case "run.complete":
        return this.runComplete(run, input);
      case "agent.ask":
      case "agent.route":
      case "agent.map":
      case "agent.message":
      case "agent.cancel":
      case "agent.propose": {
        // Teammate calls happen in jobs, never in the main thread (ADR-0041 item 5).
        if (run.kind === "conversation") return refused("fork_first");
        if (!morrowJob) return refused("not_offered");
        return this.agentTool(run, spec, input, call, deferred, authorized());
      }
      default:
        throw Error("EVAL_REPLAY_TOOL:" + spec.name);
    }
  }

  /** The audience rule (ADR-0041 item 25), and memory that must never reach any run. */
  private memoryReadable(run: RunState, f: EvalFixture): boolean {
    const m = f.memory;
    if (m === null) return true;
    if (m.tenant !== "this" || m.deleted || m.audience === "other_person") return false;
    if (m.audience === "ask_private" && this.evalCase.entry.surface !== "ask") return false;
    if (f.kind === "notebook_entry" && m.agent !== run.agent) return false;
    return true;
  }
  private memoryRead(
    run: RunState,
    input: Record<string, unknown>,
    read: (f: EvalFixture) => void,
  ): Decision {
    const target = input.target as Record<string, unknown>;
    const page = input.page as number;
    const kind = target.kind as string;
    const id = target.id as string | null;
    // MemoryReadTarget's code rules: label only for label, sequence only for teammate_result,
    // positions only for messages, id for every other kind.
    const shaped =
      (kind === "label") === (target.label !== null) &&
      (kind === "messages") === (target.fromPosition !== null) &&
      (kind === "messages" || target.toPosition === null) &&
      (kind === "teammate_result" || target.sequence === null) &&
      (kind === "label" || id !== null);
    if (!shaped) return refused("input_invalid");
    switch (kind) {
      case "result_item": {
        const item = run.items.get(id!);
        if (!item) return refused("item_not_received");
        if (page > item.pages) return refused("page_out_of_range");
        for (const entry of item.taint) run.taint.add(entry);
        return ok();
      }
      case "teammate_result": {
        const call = run.calls.get(id!);
        if (!call || !call.delivered) return refused("call_not_found");
        if (call.result!.readTags.includes("customer")) return refused("result_customer_tagged");
        run.taint.add("teammate_result:" + call.callId);
        return ok();
      }
      case "label": {
        // This context's own log: a result label reopens only while every part still passes.
        const label = target.label as string;
        if (label.startsWith("c") && run.okLabels.has(label)) return ok();
        if (label.startsWith("t") && Number(label.slice(1)) <= run.turns.length) return ok();
        return refused("recall_out_of_scope");
      }
      case "knowledge_page":
      case "notebook_entry":
      case "person_memory":
      case "conversation_summary": {
        // A model-written id is never authority to read: memory opens only when the audience
        // rule passes and the run found it (a search hit or its opening); knowledge pages are
        // the workspace's approved pages.
        const f = this.evalCase.fixtures.find((x) => x.recordId === id && x.kind === kind);
        if (!f || !this.memoryReadable(run, f)) return refused("id_out_of_scope");
        if (f.kind !== "knowledge_page" && !run.scope.has(f.recordId))
          return refused("id_out_of_scope");
        read(f);
        return ok();
      }
      default:
        return refused("id_out_of_scope");
    }
  }

  private runPlan(run: RunState, input: Record<string, unknown>): Decision {
    const action = input.action as string;
    const plan = input.plan as Record<string, unknown> | null;
    const changes = input.changes as Record<string, unknown>[] | null;
    if (
      (action === "set") !== (plan !== null) ||
      (action === "update") !== (changes !== null)
    )
      return refused("input_invalid");
    if (action === "read") return run.plan ? ok() : refused("plan_not_set");
    if (action === "set") {
      if (run.plan !== null) return refused("input_invalid");
      const items = new Map<string, string>();
      for (const phase of plan!.phases as { items: { itemKey: string }[] }[])
        for (const item of phase.items) items.set(item.itemKey, "open");
      for (const item of plan!.followThrough as { itemKey: string }[]) items.set(item.itemKey, "follow_through");
      if (items.size !== (plan!.phases as { items: unknown[] }[]).reduce((n, p) => n + p.items.length, 0) + (plan!.followThrough as unknown[]).length)
        return refused("input_invalid");
      // Morrow's plan holds the person-facing `understood` and steps; no other run's does.
      const morrow = run.agent === "morrow";
      if (morrow !== (plan!.understood !== null) || morrow !== (plan!.steps !== null))
        return refused("input_invalid");
      run.plan = { items };
      this.event(run, "plan:set");
      this.progress(run);
      if (run.kind === "conversation") {
        // Starting a job forks the main thread: the fork starts from the same prefix, with the
        // plan, and carries it out; the main thread stays free (ADR-0041 item 5).
        const key = "job-" + (this.pendingForks.length + this.order.filter((r) => r.kind === "job").length + 1);
        const fork = this.newRun(key, "morrow", "job", run);
        fork.plan = { items: new Map(items) };
        for (const entry of run.taint) fork.taint.add(entry);
        for (const id of run.scope) fork.scope.add(id);
        for (const id of run.touched) fork.touched.add(id);
        run.plan = null;
        this.pendingForks.push(fork);
        this.event(run, "fork:job");
        return ok(null, null, [key]);
      }
      return ok();
    }
    if (run.plan === null) return refused("plan_not_set");
    for (const change of changes!) {
      const shaped = change.kind === "item_status";
      if (!shaped) continue;
      const key = change.itemKey as string | null;
      const status = change.status as string | null;
      if (key === null || status === null || !run.plan.items.has(key)) return refused("input_invalid");
      if ((status === "dropped" || status === "blocked") && change.reason === null)
        return refused("input_invalid");
    }
    for (const change of changes!) {
      if (change.kind === "item_status") run.plan.items.set(change.itemKey as string, change.status as string);
      if (change.kind === "add_item") {
        const item = change.item as { itemKey: string } | null;
        if (item) run.plan.items.set(item.itemKey, "open");
      }
    }
    this.event(run, "plan:update");
    this.progress(run);
    return ok();
  }

  private resultWrite(run: RunState, input: Record<string, unknown>): Decision {
    const itemId = input.itemId as string | null;
    const close = input.close as boolean;
    if (itemId === null) {
      const kind = input.kind as "text" | "table" | "file" | null;
      const columns = input.columns as string[] | null;
      if (input.title === null || kind === null || input.mediaType === null) return refused("input_invalid");
      if ((kind === "table") !== (columns !== null)) return refused("input_invalid");
      if ((kind === "table" && input.text !== null) || (kind !== "table" && input.rows !== null))
        return refused("input_invalid");
      const id = "item_" + run.key.replace("-", "_") + "_" + (run.items.size + 1);
      run.items.set(id, {
        itemId: id,
        kind,
        title: input.title as string,
        pages: input.text !== null || input.rows !== null ? 1 : 0,
        taint: new Set(),
        open: !close,
        owner: run.key,
        columns: columns?.length ?? 0,
      });
      run.created.push(id);
      run.scope.add(id);
      return ok();
    }
    const item = run.items.get(itemId);
    if (!item || item.owner !== run.key) return refused("id_out_of_scope");
    if (!item.open) return refused("item_closed");
    if (input.title !== null || input.kind !== null || input.mediaType !== null || input.columns !== null)
      return refused("input_invalid");
    const rows = input.rows as string[][] | null;
    if ((item.kind === "table") !== (rows !== null) || (item.kind === "table" && input.text !== null))
      return refused("input_invalid");
    if (rows && rows.some((row) => row.length !== item.columns)) return refused("input_invalid");
    if (rows !== null || input.text !== null)
      run.items.set(itemId, { ...item, pages: item.pages + 1, open: !close });
    else run.items.set(itemId, { ...item, open: !close });
    return ok();
  }

  /** The gate (ADR-0041 item 16): the one way a job or a call finishes. */
  private runComplete(run: RunState, input: Record<string, unknown>): Decision {
    const outcome = input.outcome as string;
    const reply = input.reply as string | null;
    const result = input.result as Record<string, unknown> | null;
    const called = run.kind === "call" || run.kind === "review";
    const morrow = run.agent === "morrow";
    // The form: a call gives its result and no reply, never `waiting`; Morrow's job a reply and
    // no result; other jobs no result.
    if (called ? result === null || reply !== null || outcome === "waiting" : result !== null)
      return refused("input_invalid");
    if (morrow && reply === null) return refused("input_invalid");
    const isJob = run.kind === "job" || run.kind === "routed";
    if (isJob && this.rules.planTool && run.plan === null) {
      this.event(run, "completion_refused:plan_not_set");
      return refused("plan_not_set");
    }
    const evidence = (input.criteria as { evidence: unknown }[]).flatMap((c) => recordIdsOf(c.evidence));
    const findings = (result?.findings as Record<string, unknown>[] | undefined) ?? [];
    const findingIds = findings.flatMap((f) => recordIdsOf(f.records));
    const items = (result?.items as string[] | undefined) ?? [];
    const terminal = new Set(["done", "blocked", "dropped", "follow_through"]);
    const failing =
      (run.plan !== null && [...run.plan.items.values()].some((s) => !terminal.has(s))) ||
      this.openCalls(run).length > 0 ||
      run.openQuestion ||
      [...evidence, ...findingIds].some((id) => !run.scope.has(id) && !run.created.includes(id)) ||
      items.some((id) => run.items.get(id)?.owner !== run.key);
    if (failing) {
      this.event(run, "completion_refused:verification_failed");
      return refused("verification_failed");
    }
    if (reply !== null) this.reply(run, "complete", reply);
    if (called) {
      const findingsOut: EvalFinding[] = findings.map((f) => ({
        kind: f.kind as string,
        title: f.title as string,
        detail: f.detail as string,
        recordIds: recordIdsOf(f.records),
      }));
      run.result = {
        callId: run.call!.callId,
        runKeys: [run.key],
        agent: run.agent as EvalTeammateRef,
        mode: run.kind === "review" ? "review" : "ask",
        outcome,
        summary: result!.summary as string,
        findings: findingsOut,
        verdicts: ((result!.verdicts as { verdict: string }[]) ?? []).map((v) => v.verdict),
        items: items.map((id) => {
          const item = run.items.get(id)!;
          return { itemId: id, kind: item.kind, title: item.title, pages: Math.max(1, item.pages) };
        }),
        createdRecordIds: [...run.created],
        readTags: sorted(run.readTags),
        tainted: run.taint.size > 0,
        taintSources: taintSources(run.taint),
      };
      this.written.push({
        runKey: run.key,
        via: "result_summary",
        text: [run.result.summary, ...findingsOut.map((f) => f.title + " " + f.detail)].join("\n"),
        tainted: run.result.tainted,
      });
    }
    if (outcome === "waiting") {
      // A promise becomes a wait: the reply is posted and the job waits (item 17).
      this.event(run, "park:approval");
      this.parkAfter = "approval";
      return ok();
    }
    this.event(run, "run:ended");
    this.settle(run, "completed");
    return ok();
  }

  private agentTool(
    run: RunState,
    spec: ToolEntry,
    input: Record<string, unknown>,
    call: EvalRecordedCall,
    deferred: RunState[],
    authorized: boolean,
  ): Decision {
    const world = this.evalCase.world;
    const named = (installationId: unknown) => {
      const target = teammateByInstallationId(installationId);
      return target !== null &&
        world.activeTeammates.includes(target) &&
        !world.paused.includes(target)
        ? target
        : null;
    };
    const briefRecords = (brief: unknown) => recordIdsOf(isObject(brief) ? brief.records : []);
    const itemsOk = (ids: string[]) => ids.every((id) => !id.startsWith("item_") || run.items.has(id));
    const nextCallId = () => "call_" + (this.job.calls + 1);
    switch (spec.name) {
      case "agent.message":
      case "agent.cancel": {
        const target = run.calls.get(input.callId as string);
        if (!target) return refused("call_not_found");
        if (spec.name === "agent.message") {
          if (target.state !== "admitted") return refused("call_not_found");
          if (!authorized) return refused("authority_denied");
          // Guidance arrives at the child's next turn boundary, carrying Morrow's taint.
          for (const child of target.children) child.inbox.push({ taint: [...run.taint], scope: [] });
          return ok(target.target, target.callId);
        }
        if (!authorized) return refused("authority_denied");
        if (target.state === "admitted") {
          // Only steps that never began are answered as not run.
          if (target.children.some((child) => child.index > 0)) return refused("call_not_idle");
          target.state = "cancelled";
          for (const child of target.children) this.settle(child, "cancelled");
          this.event(run, "cancel:not_run");
          return ok(target.target, target.callId);
        }
        if (target.state !== "finished") return refused("call_not_found");
        target.state = "released";
        this.event(run, "cancel:released");
        return ok(target.target, target.callId);
      }
      case "agent.propose": {
        const tools = input.tools as string[];
        if (tools.some((tool) => !cardTools.has(tool))) return refused("card_tool_excluded");
        if (!authorized) return refused("authority_denied");
        this.cards.push({
          cardId: "card_" + run.key + "_" + (this.cards.length + 1),
          runKey: run.key,
          tainted: run.taint.size > 0,
        });
        return ok();
      }
      case "agent.route": {
        const target = named(input.installationId);
        if (target === null) return refused("teammate_unavailable");
        const records = briefRecords(input.brief);
        if (!itemsOk(records)) return refused("item_not_received", target);
        // A hand-off makes a teammate own the conversation: never inside a person's Ask.
        if (this.evalCase.entry.surface === "ask") return refused("hand_off_in_ask", target);
        if (!authorized) return refused("authority_denied", target);
        const key = call.expect.children[0] ?? "unrecorded-1";
        const child = this.admitChild(run, key, target, "routed", records);
        if (child === "parked") {
          this.parkAfter = "credits";
          return notRun();
        }
        this.job.calls += 1;
        deferred.push(child);
        return ok(target, null, [key]);
      }
      case "agent.ask": {
        const followUpOf = input.followUpOf as string | null;
        const mode = input.mode as "ask" | "review";
        if ((followUpOf === null) !== (input.installationId !== null)) return refused("input_invalid");
        if (mode === "review" && !this.rules.reviewMode) return refused("not_offered");
        const records = briefRecords(input.brief);
        if (followUpOf !== null) {
          if (!this.rules.followUps) return refused("input_invalid");
          const prior = run.calls.get(followUpOf);
          if (!prior || prior.mode !== "ask") return refused("call_not_found");
          if (prior.state !== "finished") return refused("call_not_idle");
          if (!itemsOk(records)) return refused("item_not_received", prior.target);
          if (!authorized) return refused("authority_denied", prior.target);
          // A follow-up reopens the same child's context: it keeps what it read.
          const child = prior.children[0]!;
          const first = this.recorded.get(child.key)!.turns[child.index];
          if (first && !this.hold(run, this.holdMicro(child.agent, first))) {
            this.parkAfter = "credits";
            return notRun();
          }
          if (first) child.preheldMicro = this.holdMicro(child.agent, first);
          for (const entry of run.taint) child.taint.add(entry);
          for (const id of records) child.scope.add(id);
          const callId = nextCallId();
          this.job.calls += 1;
          const state = this.newCall(run, callId, "ask", prior.target, [child]);
          child.call = state;
          child.state = "running";
          prior.state = "released";
          return this.afterAdmit(run, state, [child.key]);
        }
        const target = named(input.installationId);
        if (target === null) return refused("teammate_unavailable");
        if (!itemsOk(records)) return refused("item_not_received", target);
        if (!authorized) return refused("authority_denied", target);
        const key = call.expect.children[0] ?? "unrecorded-1";
        const child = this.admitChild(run, key, target, mode === "review" ? "review" : "call", records);
        if (child === "parked") {
          this.parkAfter = "credits";
          return notRun();
        }
        const callId = nextCallId();
        this.job.calls += 1;
        const state = this.newCall(run, callId, mode, target, [child]);
        child.call = state;
        return this.afterAdmit(run, state, [key]);
      }
      case "agent.map": {
        const target = named(input.installationId);
        if (target === null) return refused("teammate_unavailable");
        const source = input.source as { records: unknown; itemId: string | null };
        const records = source.records === null ? [] : recordIdsOf(source.records);
        if ((source.records === null) === (source.itemId === null)) return refused("input_invalid");
        if (source.itemId !== null && !run.items.has(source.itemId)) return refused("item_not_received", target);
        if (records.some((id) => !run.scope.has(id))) return refused("id_out_of_scope", target);
        const template = briefRecords(input.briefTemplate);
        if (!itemsOk(template)) return refused("item_not_received", target);
        if (!authorized) return refused("authority_denied", target);
        const size = input.batchSize as number;
        const sourceIds = source.itemId !== null ? [] : records;
        const batches = source.itemId !== null ? 1 : Math.ceil(sourceIds.length / size);
        const keys = call.expect.children;
        if (keys.length !== batches) throw new StaleRecording("map_batches", run.key + ":" + call.id);
        const children: RunState[] = [];
        for (let i = 0; i < batches; i += 1) {
          const batch = sourceIds.slice(i * size, (i + 1) * size);
          const child = this.admitChild(run, keys[i]!, target, "call", [...template, ...batch]);
          if (child === "parked") {
            // Batches admitted so far run once the job resumes; here the job waits.
            this.parkAfter = this.evalCase.world.atCheckIn === "continue" ? "credits" : "children";
            return notRun();
          }
          children.push(child);
        }
        const callId = nextCallId();
        this.job.calls += 1;
        const state = this.newCall(run, callId, "map", target, children);
        for (const child of children) child.call = state;
        return this.afterAdmit(run, state, keys.slice());
      }
      default:
        throw Error("EVAL_REPLAY_TOOL:" + spec.name);
    }
  }
  private newCall(
    run: RunState,
    callId: string,
    mode: CallState["mode"],
    target: EvalTeammateRef,
    children: RunState[],
  ): CallState {
    const state: CallState = {
      callId,
      mode,
      target,
      children,
      state: "admitted",
      delivered: false,
      result: null,
      itemTaint: new Set(),
    };
    run.calls.set(callId, state);
    return state;
  }
  /** An asynchronous call returns at once; under sync_calls@1 it runs inside the call. */
  private afterAdmit(run: RunState, state: CallState, keys: string[]): Decision {
    if (!this.rules.asyncCalls) {
      this.runCall(run, state);
      this.deliver(run, state);
      if (state.result?.readTags.includes("customer"))
        return { ...refused("result_customer_tagged", state.target), callId: state.callId, children: keys };
    }
    return ok(state.target, state.callId, keys);
  }
}

/** Whether any query word (three letters or more) appears in a text, case-insensitively. */
function matches(text: string, queries: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return queries.some((query) =>
    query
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3)
      .some((word) => haystack.includes(word)),
  );
}

export interface EvalReplayOptions {
  readonly wallet?: EvalWalletRules;
  /** Test-only: a smaller safety profile, so a check-in fires without a thousand turns. */
  readonly safety?: EvalSafetyProfile;
}
/** Replays one recording of one case under one arm. */
export async function replayCase(
  evalCase: EvalCase,
  recording: EvalRecording,
  arm: EvalArm,
  options: EvalReplayOptions = {},
): Promise<EvalTrace> {
  return new Replay(
    evalCase,
    recording,
    arm,
    options.wallet ?? evalWalletRules,
    options.safety ?? evalSafetyProfile,
  ).replay();
}
