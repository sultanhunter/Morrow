// The replay runner (ADR-0037 item 10; its plan's PR 9): runs one case's recorded model
// outputs in the eval world, with every check in code, and returns the trace the scorer
// grades. Deterministic: no clock, randomness, network or model call. It stands in for the
// agent loop (PR #64) and teammate calls (ADR-0037 plan PRs 4 and 5) until they land, so it
// checks what a design makes the model do (which tools, in which turns, against which
// refusals, with what taint), not the loop's durable steps, which their own tests and labs
// cover. Its order of checks follows ADR-0027 item 2: the reply's shape (outside it the run
// ends invalid_output), the run's tool-call limit, the full input definition (invalid_input),
// ids in scope, authority, then the call's own stops, children and credits, then dispatch.
//
// A recording is model output bound to the inputs it was recorded on: it names its case,
// design and the digest of the case's inputs, and each recorded call the outcome it met.
// When the world answers differently (a changed fixture or fake, or a hand edit), the
// recording is stale and the case is an error, never a pass or a fail.
import type { Current_AssistantModelMessage } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { canonicalJson, recordingBasisDigest, sha256Hex } from "./canonical";
import type {
  EvalAgentRef,
  EvalCallOutcome,
  EvalCase,
  EvalDesign,
  EvalEndCode,
  EvalFixture,
  EvalListingField,
  EvalNextStep,
  EvalRecordedCall,
  EvalRecordedRun,
  EvalRecording,
  EvalRefusalCode,
  EvalResultDraft,
  EvalTaintSource,
  EvalTeammateRef,
} from "./format";
import {
  checkEvalToolInput,
  evalOfferedTools,
  evalRunLimits,
  evalWalletRules,
  microPerCredit,
  teammateByInstallationId,
  type EvalRunKind,
  type EvalToolSpec,
  type EvalWalletRules,
} from "./world";

// --- The trace ----------------------------------------------------------------------------
export interface EvalCallTrace {
  readonly id: string;
  readonly tool: string;
  readonly input: unknown;
  readonly outcome: EvalCallOutcome;
  readonly refusal: EvalRefusalCode | null;
  /** For `agent.ask` and `agent.route`: the teammate named, and the child run if admitted. */
  readonly target: EvalTeammateRef | null;
  readonly child: string | null;
}
export interface EvalTurnTrace {
  readonly turn: number;
  readonly final: boolean;
  /** Every tool the reply named, dispatched or not (an unoffered one ends the run). */
  readonly attemptedTools: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly calls: readonly EvalCallTrace[];
}
export interface EvalResultItem {
  readonly itemId: string;
  readonly kind: "table" | "text";
  readonly title: string;
  readonly pages: number;
}
/** A teammate's result as code builds it (provisional TeammateResult, ADR-0037 item 3(a)). */
export interface EvalTeammateResult {
  readonly resultId: string;
  readonly runKey: string;
  readonly agent: EvalTeammateRef;
  readonly endCode: EvalEndCode;
  readonly outcome: "done" | "partial" | "blocked" | "failed";
  readonly counts: {
    readonly proposals: number;
    readonly productsRead: number;
    readonly reports: number;
    readonly suggestions: number;
  };
  readonly createdRecordIds: readonly string[];
  readonly nextSteps: readonly EvalNextStep[];
  readonly summary: string;
  readonly findings: EvalResultDraft["findings"];
  readonly items: readonly EvalResultItem[];
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
  /** The run's last text: the answer the person sees (a called run's goes to Morrow). */
  readonly reply: string | null;
  readonly creditsDrawn: number;
  readonly result: EvalTeammateResult | null;
}
export interface EvalProposalTrace {
  readonly proposalId: string;
  readonly kind: "catalog.listing" | "support.reply";
  readonly agent: EvalTeammateRef;
  readonly runKey: string;
  readonly changes: readonly {
    readonly productId: string;
    readonly set: readonly EvalListingField[];
  }[];
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
export interface EvalStale {
  readonly code: string;
  readonly where: string;
}
export interface EvalTrace {
  readonly caseId: string;
  readonly design: EvalDesign;
  readonly admission: "admitted" | EvalRefusalCode;
  readonly endCode: EvalEndCode;
  readonly runs: readonly EvalRunTrace[];
  readonly proposals: readonly EvalProposalTrace[];
  readonly cards: readonly EvalCardTrace[];
  readonly records: {
    readonly tasks: number;
    readonly suggestions: number;
    readonly reports: number;
    readonly posts: number;
  };
  /** Store writes, messages to customers or any other effect outside Morrow: none may happen. */
  readonly externalEffects: number;
  readonly creditsDrawn: number;
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
interface Item extends EvalResultItem {
  readonly taint: ReadonlySet<string>;
}
interface RunState {
  readonly key: string;
  readonly agent: EvalAgentRef;
  readonly kind: EvalRunKind;
  readonly parent: string | null;
  readonly tools: ReadonlyMap<string, EvalToolSpec>;
  readonly turnLimit: number;
  readonly turns: EvalTurnTrace[];
  /** "source:recordId" entries of untrusted content the run consumed. */
  readonly taint: Set<string>;
  readonly readTags: Set<"customer">;
  /** Record ids the run may name: what it read, created or received, and its brief's. */
  readonly scope: Set<string>;
  readonly items: Map<string, Item>;
  readonly created: string[];
  readonly productsRead: Set<string>;
  readonly counts: { proposals: number; reports: number; suggestions: number };
  toolCalls: number;
  routed: boolean;
  reserveMicro: number;
  usedMicro: number;
  reply: string | null;
  draft: EvalResultDraft | null;
  endCode: EvalEndCode | null;
  creditsDrawn: number;
  result: EvalTeammateResult | null;
}
interface ProposalDraft {
  readonly proposalId: string;
  readonly kind: EvalProposalTrace["kind"];
  readonly agent: EvalTeammateRef;
  readonly runKey: string;
  readonly changes: EvalProposalTrace["changes"];
  readonly content: unknown;
  readonly tainted: boolean;
}
interface Deferred {
  readonly index: number;
  readonly call: EvalRecordedCall;
  readonly mode: "ask" | "route";
  readonly child: RunState;
}
type Decision = {
  outcome: EvalCallOutcome;
  refusal: EvalRefusalCode | null;
  target: EvalTeammateRef | null;
  child: string | null;
};
const refused = (code: EvalRefusalCode, target: EvalTeammateRef | null = null): Decision => ({
  outcome: code === "input_invalid" ? "invalid_input" : "refused",
  refusal: code,
  target,
  child: null,
});
const ok = (target: EvalTeammateRef | null = null, child: string | null = null): Decision => ({
  outcome: "ok",
  refusal: null,
  target,
  child,
});
const sourceOf = (fixture: EvalFixture): EvalTaintSource =>
  (
    ({
      product: "product",
      order_summary: "order_summary",
      inventory: "inventory",
      knowledge_page: "knowledge_page",
      support_thread: "support_mail",
    }) as const
  )[fixture.kind];
const sorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort();
const taintSources = (taint: ReadonlySet<string>): EvalTaintSource[] =>
  sorted([...taint].map((entry) => entry.split(":")[0] as EvalTaintSource));

class Replay {
  private readonly runs = new Map<string, RunState>();
  private readonly order: RunState[] = [];
  private readonly recorded = new Map<string, EvalRecordedRun>();
  private readonly consumed = new Set<string>();
  private readonly proposals: ProposalDraft[] = [];
  private readonly cards: EvalCardTrace[] = [];
  private readonly records = { tasks: 0, suggestions: 0, reports: 0, posts: 0 };
  private children = 0;
  private readonly wallet: { balance: number; used: number; held: number };

  constructor(
    private readonly evalCase: EvalCase,
    private readonly recording: EvalRecording,
    private readonly design: EvalDesign,
    private readonly rules: EvalWalletRules,
  ) {
    for (const run of recording.runs) this.recorded.set(run.runKey, run);
    this.wallet = { balance: evalCase.world.creditBalance * microPerCredit, used: 0, held: 0 };
  }

  private available() {
    return this.wallet.balance - this.wallet.used - this.wallet.held;
  }
  private hold(micro: number): boolean {
    if (this.available() < micro) return false;
    this.wallet.held += micro;
    return true;
  }
  private worstCase(agent: EvalAgentRef): number {
    const w = this.rules.worstCaseTurnCredits;
    return (agent === "morrow" ? w.morrow : w.teammate) * microPerCredit;
  }

  /** Admission: the switch-free part the eval world models (stops and credits). */
  private admit(
    key: string,
    agent: EvalAgentRef,
    kind: EvalRunKind,
    parent: RunState | null,
  ): RunState | EvalRefusalCode {
    if (agent !== "morrow" && this.evalCase.world.paused.includes(agent)) return "stopped";
    if (parent !== null && this.children >= evalRunLimits.childrenPerEnvelope)
      return "children_limit";
    // ADR-0039 item 2(d): the final-turn reserve, as proposed; a call that cannot be covered
    // at once is refused at once (ADR-0037 item 3(a)), never waits for credits.
    const reserve = this.worstCase(agent);
    if (!this.hold(reserve)) return "insufficient_credits";
    if (!this.rules.finalTurnReserve) this.wallet.held -= reserve;
    if (parent !== null) this.children += 1;
    const state: RunState = {
      key,
      agent,
      kind,
      parent: parent?.key ?? null,
      tools: evalOfferedTools(agent, kind, this.design),
      turnLimit: agent === "morrow" ? evalRunLimits.turns.morrow : evalRunLimits.turns.teammate,
      turns: [],
      taint: new Set(),
      readTags: new Set(),
      scope: new Set(),
      items: new Map(),
      created: [],
      productsRead: new Set(),
      counts: { proposals: 0, reports: 0, suggestions: 0 },
      toolCalls: 0,
      routed: false,
      reserveMicro: this.rules.finalTurnReserve ? reserve : 0,
      usedMicro: 0,
      reply: null,
      draft: null,
      endCode: null,
      creditsDrawn: 0,
      result: null,
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
      if (this.recording.design !== this.design)
        throw new StaleRecording("design_mismatch", "recording");
      if (this.recording.basisDigest !== (await recordingBasisDigest(this.evalCase)))
        throw new StaleRecording("basis_mismatch", "recording");
      const entry = this.evalCase.entry;
      const root = this.admit("root", entry, entry === "morrow" ? "coordinator" : "routed", null);
      if (typeof root === "string") {
        admission = root;
        this.consumed.add("root");
        if ((this.recorded.get("root")?.turns.length ?? 0) !== 0)
          throw new StaleRecording("turns_left", "root");
        if (this.recorded.get("root")?.agent !== entry)
          throw new StaleRecording("run_agent", "root");
      } else this.loop(root);
      for (const key of this.recorded.keys())
        if (!this.consumed.has(key)) throw new StaleRecording("run_unused", key);
    } catch (error) {
      if (!(error instanceof StaleRecording)) throw error;
      stale = { code: error.code, where: error.where };
    }
    const proposals: EvalProposalTrace[] = [];
    for (const draft of this.proposals)
      proposals.push({
        proposalId: draft.proposalId,
        kind: draft.kind,
        agent: draft.agent,
        runKey: draft.runKey,
        changes: draft.changes,
        digest: await sha256Hex(canonicalJson(draft.content)),
        status: "awaiting_approval",
        tainted: draft.tainted,
      });
    const runs = this.order.map((run) => this.runTrace(run));
    const root = runs.find((run) => run.runKey === "root");
    return {
      caseId: this.evalCase.caseId,
      design: this.design,
      admission,
      endCode: admission === "admitted" ? (root?.endCode ?? "invalid_output") : "not_admitted",
      runs,
      proposals,
      cards: this.cards,
      records: { ...this.records },
      externalEffects: 0,
      creditsDrawn: runs.reduce((sum, run) => sum + run.creditsDrawn, 0),
      stale,
    };
  }

  private runTrace(run: RunState): EvalRunTrace {
    return {
      runKey: run.key,
      agent: run.agent,
      kind: run.kind,
      parent: run.parent,
      endCode: run.endCode ?? "invalid_output",
      turns: run.turns,
      tainted: run.taint.size > 0,
      taintSources: taintSources(run.taint),
      readTags: sorted(run.readTags),
      reply: run.reply,
      creditsDrawn: run.creditsDrawn,
      result: run.result,
    };
  }

  private end(run: RunState, code: EvalEndCode) {
    run.endCode = code;
    this.wallet.held -= run.reserveMicro;
    run.reserveMicro = 0;
    const settled = Math.ceil(run.usedMicro / microPerCredit) * microPerCredit;
    if (!this.rules.failedRunsDraw && code !== "completed") {
      this.wallet.used -= run.usedMicro;
      run.creditsDrawn = 0;
    } else {
      this.wallet.used += settled - run.usedMicro;
      run.creditsDrawn = settled / microPerCredit;
    }
    if (run.kind === "called") run.result = this.buildResult(run);
  }

  private buildResult(run: RunState): EvalTeammateResult {
    let draft = run.draft;
    // A finding may name only records the teammate read or created: a model-written id is
    // never authority to read (ADR-0037 item 3(a)). Otherwise the result is invalid output.
    if (
      draft &&
      draft.findings.some((f) =>
        f.recordIds.some((id) => !run.scope.has(id) && !run.created.includes(id)),
      )
    ) {
      draft = null;
      run.endCode = "invalid_output";
    }
    const items = (draft?.items ?? []).map((item, index) => ({
      itemId: "item_" + run.key + "_" + (index + 1),
      kind: item.kind,
      title: item.title,
      pages: item.pages,
    }));
    return {
      resultId: "result_" + run.key,
      runKey: run.key,
      agent: run.agent as EvalTeammateRef,
      endCode: run.endCode ?? "invalid_output",
      outcome: draft?.outcome ?? (run.endCode === "completed" ? "partial" : "failed"),
      counts: {
        proposals: run.counts.proposals,
        productsRead: run.productsRead.size,
        reports: run.counts.reports,
        suggestions: run.counts.suggestions,
      },
      createdRecordIds: [...run.created],
      nextSteps: draft?.nextSteps ?? ["none"],
      summary: draft?.summary ?? "",
      findings: draft?.findings ?? [],
      items,
      readTags: sorted(run.readTags),
      tainted: run.taint.size > 0,
      taintSources: taintSources(run.taint),
    };
  }

  private loop(run: RunState): void {
    const recorded = this.recorded.get(run.key);
    if (!recorded) throw new StaleRecording("run_missing", run.key);
    if (recorded.agent !== run.agent) throw new StaleRecording("run_agent", run.key);
    this.consumed.add(run.key);
    const rates = this.rules.microCreditsPerToken;
    let index = 0;
    for (;;) {
      const turnNumber = index + 1;
      if (run.key === "root" && this.evalCase.world.stopBeforeTurn === turnNumber) {
        this.end(run, "stopped");
        break;
      }
      // Before each turn, in code: the turn limit, then a hold of the turn's worst case
      // beside the reserve; when the wallet cannot cover it, the final turn from the reserve
      // (ADR-0039 item 2(e)), with no tools.
      let final = turnNumber >= run.turnLimit;
      let creditsFinal = false;
      let holdMicro = 0;
      if (!final) {
        if (this.hold(this.worstCase(run.agent))) holdMicro = this.worstCase(run.agent);
        else if (this.rules.finalTurnReserve) {
          final = true;
          creditsFinal = true;
        } else {
          this.end(run, "credits_exhausted");
          break;
        }
      }
      if (final) {
        if (this.rules.finalTurnReserve) {
          holdMicro = run.reserveMicro;
          run.reserveMicro = 0;
        } else if (this.hold(this.worstCase(run.agent))) holdMicro = this.worstCase(run.agent);
        else {
          this.end(run, "credits_exhausted");
          break;
        }
      }
      const turn = recorded.turns[index];
      if (!turn) throw new StaleRecording("turn_missing", run.key + "#" + turnNumber);
      index += 1;
      const metered = turn.usage.inputTokens * rates.input + turn.usage.outputTokens * rates.output;
      this.wallet.held -= holdMicro;
      this.wallet.used += metered;
      run.usedMicro += metered;
      const calls: EvalCallTrace[] = [];
      run.turns.push({
        turn: turnNumber,
        final,
        attemptedTools: turn.calls.map((call) => call.tool),
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        calls,
      });
      if (!this.replyValid(run, turn.text, turn.calls, turn.result, final)) {
        this.end(run, "invalid_output");
        break;
      }
      if (metered > holdMicro) {
        // Overflow: booked, never dropped, and the run ends (ADR-0039 item 9).
        this.end(run, "cost_budget");
        break;
      }
      if (turn.calls.length === 0) {
        run.reply = turn.text;
        run.draft = turn.result;
        this.end(run, creditsFinal ? "credits_exhausted" : final ? "turn_limit" : "completed");
        break;
      }
      this.dispatchTurn(run, turn.calls, calls);
    }
    if (index !== recorded.turns.length)
      throw new StaleRecording("turns_left", run.key + "#" + (index + 1));
  }

  /** The reply's shape, as the gateway checks it (ADR-0027 item 4). */
  private replyValid(
    run: RunState,
    text: string | null,
    calls: readonly EvalRecordedCall[],
    result: EvalResultDraft | null,
    final: boolean,
  ): boolean {
    if (calls.length > evalRunLimits.toolCallsPerTurn) return false;
    if (final && calls.length > 0) return false;
    // A teammate's result ends a called run's last turn, and only that.
    if (result !== null && (run.kind !== "called" || calls.length > 0)) return false;
    if (run.kind === "called" && calls.length === 0 && result === null && !final) return false;
    const specs = calls.map((call) => run.tools.get(call.tool));
    if (specs.some((spec) => spec === undefined)) return false;
    const content: Current_AssistantModelMessage["content"][number][] = [];
    if (text !== null) content.push({ type: "text", text });
    calls.forEach((call, i) => {
      if (specs[i]!.source === "catalogue")
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.tool,
          input: call.input,
        } as Current_AssistantModelMessage["content"][number]);
    });
    if (
      content.length &&
      !validateCurrentDefinition("AssistantModelMessage", { role: "assistant", content })
    )
      return false;
    return calls.every(
      (call, i) =>
        specs[i]!.source === "catalogue" || checkEvalToolInput(specs[i]!, call.input) !== "shape",
    );
  }

  private dispatchTurn(run: RunState, calls: readonly EvalRecordedCall[], out: EvalCallTrace[]) {
    const decisions: Decision[] = [];
    const deferred: Deferred[] = [];
    calls.forEach((call, index) => {
      const decision = this.decide(run, call, (mode, child) =>
        deferred.push({ index, call, mode, child }),
      );
      decisions.push(decision);
    });
    // Admitted calls and hand-offs run after the turn's calls are decided: parallel calls are
    // each admitted, and hold their reserve, before any of them runs.
    for (const item of deferred) {
      this.loop(item.child);
      if (item.mode === "ask")
        decisions[item.index] = this.receive(run, item.child, decisions[item.index]!);
    }
    calls.forEach((call, index) => {
      const decision = decisions[index]!;
      out.push({
        id: call.id,
        tool: call.tool,
        input: call.input,
        outcome: decision.outcome,
        refusal: decision.refusal,
        target: decision.target,
        child: decision.child,
      });
      if (
        decision.outcome !== call.expect.outcome ||
        decision.refusal !== call.expect.refusal ||
        decision.child !== call.expect.child
      )
        throw new StaleRecording("call_outcome", run.key + ":" + call.id);
    });
  }

  /** A called teammate's result reaches Morrow's run as wrapped, tainting data. */
  private receive(run: RunState, child: RunState, decision: Decision): Decision {
    const result = child.result!;
    // ADR-0037 item 3(a): a result with a customer read tag never enters Morrow's context.
    if (result.readTags.includes("customer"))
      return { ...refused("customer_tagged", decision.target), child: child.key };
    for (const entry of child.taint) run.taint.add(entry);
    run.scope.add(result.resultId);
    for (const id of result.createdRecordIds) run.scope.add(id);
    for (const finding of result.findings) for (const id of finding.recordIds) run.scope.add(id);
    for (const item of result.items) {
      run.scope.add(item.itemId);
      run.items.set(item.itemId, { ...item, taint: new Set(child.taint) });
    }
    return decision;
  }

  private decide(
    run: RunState,
    call: EvalRecordedCall,
    defer: (mode: "ask" | "route", child: RunState) => void,
  ): Decision {
    const spec = run.tools.get(call.tool)!;
    run.toolCalls += 1;
    if (run.toolCalls > evalRunLimits.toolCallsPerRun) return refused("tool_call_limit");
    if (checkEvalToolInput(spec, call.input) !== "ok") return refused("input_invalid");
    const input = call.input as Record<string, unknown>;
    const fixtures = this.evalCase.fixtures;
    const world = this.evalCase.world;
    const authorized = () => !world.requesterLacks.includes(spec.capabilityId);
    const taint = (fixture: EvalFixture) =>
      run.taint.add(sourceOf(fixture) + ":" + fixture.recordId);
    switch (spec.name) {
      case "products.read": {
        if (!authorized()) return refused("authority_denied");
        const ids = input.productIds as string[] | null;
        const title = (input.titleContains as string | null)?.toLowerCase() ?? null;
        const found = fixtures
          .filter((f) => f.kind === "product")
          .filter((f) => ids === null || ids.includes(f.recordId))
          .filter(
            (f) =>
              title === null ||
              (f.kind === "product" && f.data.title.toLowerCase().includes(title)),
          )
          .slice(0, input.limit as number);
        for (const f of found) {
          taint(f);
          run.scope.add(f.recordId);
          run.productsRead.add(f.recordId);
        }
        return ok();
      }
      case "inventory.read":
      case "orders.summary": {
        if (!authorized()) return refused("authority_denied");
        const kind = spec.name === "inventory.read" ? "inventory" : "order_summary";
        for (const f of fixtures) {
          if (f.kind !== kind) continue;
          if (f.kind === "order_summary" && f.data.metric !== input.metric) continue;
          taint(f);
          if (f.kind === "inventory" || f.kind === "order_summary")
            for (const row of f.data.rows) run.scope.add(row.recordId);
        }
        return ok();
      }
      case "support.thread.read": {
        const thread = fixtures.find(
          (f) => f.kind === "support_thread" && f.recordId === input.threadId,
        );
        if (!thread) return refused("id_out_of_scope");
        if (!authorized()) return refused("authority_denied");
        taint(thread);
        run.readTags.add("customer");
        run.scope.add(thread.recordId);
        return ok();
      }
      case "knowledge.search": {
        if (!authorized()) return refused("authority_denied");
        const needle = (input.searchText as string).toLowerCase();
        const found = fixtures
          .filter((f) => f.kind === "knowledge_page")
          .filter(
            (f) =>
              f.kind === "knowledge_page" &&
              (f.data.title.toLowerCase().includes(needle) ||
                f.data.body.toLowerCase().includes(needle)),
          )
          .slice(0, input.limit as number);
        for (const f of found) {
          taint(f);
          run.scope.add(f.recordId);
        }
        return ok();
      }
      case "work.read": {
        if (input.id !== null && !run.scope.has(input.id as string))
          return refused("id_out_of_scope");
        return authorized() ? ok() : refused("authority_denied");
      }
      case "message.post":
      case "task.create":
      case "suggestion.create":
      case "report.write": {
        if (!authorized()) return refused("authority_denied");
        if (spec.name === "message.post") this.records.posts += 1;
        else if (spec.name === "task.create") {
          this.records.tasks += 1;
          run.created.push("task_" + run.key + "_" + this.records.tasks);
        } else if (spec.name === "suggestion.create") {
          this.records.suggestions += 1;
          run.counts.suggestions += 1;
          run.created.push("suggestion_" + run.key + "_" + run.counts.suggestions);
        } else {
          this.records.reports += 1;
          run.counts.reports += 1;
          run.created.push("report_" + run.key + "_" + run.counts.reports);
        }
        return ok();
      }
      case "proposal.listing": {
        const changes = input.changes as {
          productId: string;
          title: unknown;
          descriptionHtml: unknown;
          seo: unknown;
          tags: unknown;
        }[];
        if (changes.some((change) => !run.scope.has(change.productId)))
          return refused("id_out_of_scope");
        if (!authorized()) return refused("authority_denied");
        run.counts.proposals += 1;
        const proposalId = "proposal_" + run.key + "_" + run.counts.proposals;
        run.created.push(proposalId);
        this.proposals.push({
          proposalId,
          kind: "catalog.listing",
          agent: run.agent as EvalTeammateRef,
          runKey: run.key,
          changes: changes.map((change) => ({
            productId: change.productId,
            set: (["title", "descriptionHtml", "seo", "tags"] as const).filter(
              (field) => change[field] !== null,
            ),
          })),
          content: { kind: "catalog.listing", agent: run.agent, changes },
          tainted: run.taint.size > 0,
        });
        return ok();
      }
      case "proposal.reply": {
        if (!run.scope.has(input.threadId as string)) return refused("id_out_of_scope");
        if (!authorized()) return refused("authority_denied");
        run.counts.proposals += 1;
        const proposalId = "proposal_" + run.key + "_" + run.counts.proposals;
        run.created.push(proposalId);
        this.proposals.push({
          proposalId,
          kind: "support.reply",
          agent: run.agent as EvalTeammateRef,
          runKey: run.key,
          changes: [],
          content: { kind: "support.reply", agent: run.agent, input },
          tainted: run.taint.size > 0,
        });
        return ok();
      }
      case "agent.ask":
      case "agent.route": {
        const target = teammateByInstallationId(input.installationId);
        if (target === null || !world.activeTeammates.includes(target))
          return refused("id_out_of_scope", target);
        const brief =
          spec.source === "provisional" ? (input.brief as { recordIds: string[] }) : null;
        const named = brief?.recordIds ?? [];
        // A result item named in a brief must belong to a result Morrow's own run received;
        // any other record the teammate opens only under its own grants (ADR-0037 item 3(a)).
        if (named.some((id) => id.startsWith("item_") && !run.items.has(id)))
          return refused("id_out_of_scope", target);
        if (!authorized()) return refused("authority_denied", target);
        const mode = spec.name === "agent.ask" ? "ask" : "route";
        // Catalogue version 2's agent.route: once per run (handoff_only@1).
        if (mode === "route" && spec.source === "catalogue" && run.routed)
          return refused("route_used", target);
        const key = call.expect.child;
        const admitted = this.admit(
          key ?? "unrecorded-1",
          target,
          mode === "ask" ? "called" : "routed",
          run,
        );
        if (typeof admitted === "string") return refused(admitted, target);
        if (key === null) throw new StaleRecording("child_unrecorded", run.key + ":" + call.id);
        if (mode === "route") run.routed = true;
        // The run's taint, and that of any item its brief names, carries into the child.
        for (const entry of run.taint) admitted.taint.add(entry);
        for (const id of named) {
          admitted.scope.add(id);
          for (const entry of run.items.get(id)?.taint ?? []) admitted.taint.add(entry);
        }
        defer(mode, admitted);
        return ok(target, key);
      }
      case "agent.result.read": {
        // Code opens an item only when it belongs to a result Morrow's own run received.
        const item = run.items.get(input.itemId as string);
        if (!item || (input.page as number) > item.pages) return refused("id_out_of_scope");
        if (!authorized()) return refused("authority_denied");
        for (const entry of item.taint) run.taint.add(entry);
        return ok();
      }
      case "agent.propose": {
        if (!authorized()) return refused("authority_denied");
        this.cards.push({
          cardId: "card_" + run.key + "_" + (this.cards.length + 1),
          runKey: run.key,
          tainted: run.taint.size > 0,
        });
        return ok();
      }
      default:
        throw Error("EVAL_REPLAY_TOOL:" + spec.name);
    }
  }
}

export interface EvalReplayOptions {
  readonly wallet?: EvalWalletRules;
}
/** Replays one recording of one case under one design. */
export async function replayCase(
  evalCase: EvalCase,
  recording: EvalRecording,
  design: EvalDesign,
  options: EvalReplayOptions = {},
): Promise<EvalTrace> {
  return new Replay(evalCase, recording, design, options.wallet ?? evalWalletRules).replay();
}
