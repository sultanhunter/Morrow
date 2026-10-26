// Deterministic fakes of the teammate-call seams (ADR-0037 item 3(a); ADR-0041 items 19 to 24,
// merged by plan row H5), so the loop, Morrow's tools, the Team page and the evals build against
// them before any table or Workflow exists. No I/O, clock or randomness: ids count up, times
// come from the caller, and every rule is teammates.ts's or harness-tools.ts's, so a fake
// cannot drift from the code the loop runs. tests/teammates.test.mjs holds their conformance
// tests.
//
// - The fake result-item store keeps items in memory with their producing run, read tags and
//   taint. A called teammate builds items across turns with result.write (start, append, close;
//   only its own run's open items); code's overflow items arrive whole and closed; a run's
//   open items close when it ends. It records which results each Morrow run received, and
//   opens an item (memory.read) for Morrow or for a called teammate only under
//   coordinatorMayOpen or teammateMayOpen. An unknown id reads as not received, so the store
//   never says whether another run's item exists.
// - The fake teammate runner admits each call alone (agent.ask, ADR-0041 item 21): an active
//   teammate; the kernel's 32 children per envelope, after which the job checks in (no
//   refusal, item 21); and the workspace balance (credits only: the caller's coversCall answers
//   whether the call's first hold fits; when it does not, nothing is admitted and the job
//   parks on credits, item 9; there is no money cap). A dispatch over subjects an earlier
//   result left with unknown outcomes is refused (retry_blocked, item 23). Each fresh call is a
//   fresh child, the same teammate again included; a follow-up (followUpOf) reopens an idle
//   child of the same run with a new brief and the next sequence, keeping what it was given
//   and its taint, and counts no new child; agent.cancel releases an idle child, or stops a
//   running one, which keeps what it did as partial and is then released. The brief the
//   teammate receives is built by code (teammateBrief), request included. The called run starts
//   with the calling run's taint and joins its own (joinRunTaint), so its items and its result
//   carry both. It builds TeammateResult@1 with buildTeammateResult for every end, so large
//   output becomes items, work done before a stop is kept as partial, and a customer-tagged
//   result never reaches Morrow.
import type {
  Current_AgentRunEndReason,
  Current_ReadTag,
  Current_ResultItem,
  Current_ResultItemPage,
  Current_ResultItemRef,
  Current_RunTaint,
  Current_TeammateBrief,
  Current_TeammateCreatedRecord,
  Current_TeammateFindingInput,
  Current_TeammatePlanProgress,
  Current_TeammateRecordRef,
  Current_TeammateRequest,
  Current_TeammateResult,
  Current_TeammateUnresolvedSubject,
  Current_ToolInputAgentAsk,
  Current_ToolInputResultWrite,
  Current_ToolInputRunComplete,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { resultWriteInputValid } from "./harness-tools";
import { canonicalText, sha256Hex } from "./projects/digest";
import {
  acceptTeammateResult,
  agentAskValid,
  buildTeammateResult,
  coordinatorMayOpen,
  csvText,
  type ItemOpenRefusal,
  joinRunTaint,
  type ResultItemContent,
  type ResultItemSink,
  resultItemPage,
  retryBlocked,
  runTaintValid,
  tablePages,
  teammateBrief,
  teammateMayOpen,
  textPages,
} from "./teammates";

/** The kernel's bound on children per envelope (ADR-0041 item 21: then the job checks in). */
export const maximumChildrenPerEnvelope = 32;

export type ItemReadOutcome =
  | { readonly ok: true; readonly page: Current_ResultItemPage }
  | { readonly ok: false; readonly refusal: ItemOpenRefusal | "page_out_of_range" };
/** result.write's outcome, as the tool-call step returns it to the model. */
export type ResultWriteOutcome =
  | {
      readonly ok: true;
      readonly itemId: string;
      readonly open: boolean;
      readonly sections: number;
      readonly pageCount: number;
    }
  | { readonly ok: false; readonly outcome: "invalid_input"; readonly refusal: "input_invalid" }
  | {
      readonly ok: false;
      readonly outcome: "refused";
      readonly refusal: "item_closed" | "item_not_received";
    };

/** The run an item belongs to: its read tags and taint, from code. */
export interface ProducingRun {
  readonly runId: string;
  readonly readTags: readonly Current_ReadTag[];
  readonly taint: Current_RunTaint;
}

export interface FakeResultItemStore {
  /** Code's sink for one producing run: an overflow item, stored whole and closed. */
  sinkFor(run: ProducingRun): ResultItemSink;
  /** result.write for one called teammate's run: only its own items, only while open. */
  writerFor(run: ProducingRun): (input: unknown) => Promise<ResultWriteOutcome>;
  /**
   * The run (or one follow-up of it) ended: the items it wrote since the last close close and
   * take the run's final read tags and taint (a superset of what it held at any write: a fake
   * sees a scripted run's tags only at its end); every item the run ever wrote is listed, in
   * write order, so a follow-up's result may cite an earlier one.
   */
  closeRun(run: ProducingRun): Promise<readonly Current_ResultItemRef[]>;
  /** Morrow's run received this result: its listed items become openable for that run. */
  receive(parentRunId: string, result: Current_TeammateResult): void;
  /** memory.read of an item for Morrow's run. */
  readForCoordinator(request: {
    readonly runId: string;
    readonly itemId: string;
    readonly page: number;
  }): ItemReadOutcome;
  /** memory.read of an item for a called or handed-off teammate whose brief names it. */
  readForTeammate(request: {
    readonly callingRunId: string;
    readonly brief: Current_TeammateBrief;
    readonly itemId: string;
    readonly page: number;
  }): ItemReadOutcome;
  /** The stored record (for tests and screens), or null. */
  item(itemId: string): Current_ResultItem | null;
  readonly size: number;
}

interface StoredItem {
  record: Current_ResultItem;
  content: ResultItemContent;
  readonly written: boolean;
}

// What a page reads: a table whose rows do not page one by one reads as its CSV text, which
// pages by characters, so nothing is cut.
const readable = (content: ResultItemContent): ResultItemContent =>
  content.kind === "table" && tablePages(content.table) === null
    ? { kind: "text", text: csvText(content.table) }
    : content;
const measured = (content: ResultItemContent) => {
  const shown = readable(content);
  if (shown.kind === "text")
    return {
      sizeBytes: new TextEncoder().encode(shown.text).length,
      pageCount: textPages(shown.text).length,
    };
  const table = shown.table;
  return {
    sizeBytes: new TextEncoder().encode(
      JSON.stringify({ columns: table.columns, rows: table.rows }),
    ).length,
    pageCount: tablePages(table)!.length,
  };
};

export function createFakeResultItemStore(options: {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly now: () => string;
}): FakeResultItemStore {
  const items = new Map<string, StoredItem>();
  const writtenBy = new Map<string, string[]>();
  const finalized = new Set<string>();
  const received = new Map<string, Set<string>>();
  let next = 1;
  const record = async (
    run: ProducingRun,
    itemId: string,
    draft: {
      kind: Current_ResultItem["kind"];
      mediaType: Current_ResultItem["mediaType"];
      title: string;
    },
    content: ResultItemContent,
    open: boolean,
    sections: number,
    createdAt: string,
  ): Promise<Current_ResultItem> => {
    const size = measured(content);
    const value: Current_ResultItem = {
      schemaVersion: 1,
      itemId,
      organizationId: options.organizationId,
      workspaceId: options.workspaceId,
      runId: run.runId,
      kind: draft.kind,
      mediaType: draft.mediaType,
      title: draft.title,
      sizeBytes: size.sizeBytes,
      pageCount: size.pageCount,
      open,
      sections,
      contentDigest: await sha256Hex(canonicalText(content)),
      readTags: run.readTags.map((t) => ({ storeId: t.storeId, capability: t.capability })),
      taint: structuredClone(run.taint),
      createdAt,
      expiresAt: null,
    };
    if (!validateCurrentDefinition("ResultItem", value)) throw Error("FAKE_ITEM_INVALID");
    return Object.freeze(value);
  };
  const read = (
    itemId: string,
    page: number,
    decide: (item: Current_ResultItem) => "ok" | ItemOpenRefusal,
  ): ItemReadOutcome => {
    const stored = items.get(itemId);
    if (!stored) return { ok: false, refusal: "item_not_received" };
    const decision = decide(stored.record);
    if (decision !== "ok") return { ok: false, refusal: decision };
    const result = resultItemPage(
      {
        itemId,
        kind: stored.record.kind,
        title: stored.record.title,
        content: readable(stored.content),
      },
      page,
    );
    return result === "page_out_of_range"
      ? { ok: false, refusal: result }
      : { ok: true, page: result };
  };
  return {
    sinkFor(run) {
      return async (draft) => {
        const itemId = `item_fake_${next++}`;
        const value = await record(run, itemId, draft, draft.content, false, 1, options.now());
        items.set(itemId, { record: value, content: draft.content, written: false });
        return itemId;
      };
    },
    writerFor(run) {
      return async (input) => {
        if (!resultWriteInputValid(input))
          return { ok: false, outcome: "invalid_input", refusal: "input_invalid" };
        const i = input as Current_ToolInputResultWrite;
        let itemId: string;
        let stored: StoredItem;
        if (i.itemId === null) {
          itemId = `item_fake_${next++}`;
          const content: ResultItemContent =
            i.kind === "table"
              ? { kind: "table", table: { columns: [...i.columns!], rows: [...(i.rows ?? [])] } }
              : { kind: "text", text: i.text ?? "" };
          const sections = i.text !== null || i.rows !== null ? 1 : 0;
          const draft = { kind: i.kind!, mediaType: i.mediaType!, title: i.title! };
          stored = {
            record: await record(run, itemId, draft, content, !i.close, sections, options.now()),
            content,
            written: true,
          };
          writtenBy.set(run.runId, [...(writtenBy.get(run.runId) ?? []), itemId]);
        } else {
          itemId = i.itemId;
          const existing = items.get(itemId);
          // Only this run's own written items: anything else reads as not received.
          if (!existing || !existing.written || existing.record.runId !== run.runId)
            return { ok: false, outcome: "refused", refusal: "item_not_received" };
          if (!existing.record.open)
            return { ok: false, outcome: "refused", refusal: "item_closed" };
          // Text goes only to text and file items, rows only to tables, one cell per column.
          const current = existing.content;
          const fits =
            current.kind === "table"
              ? i.text === null &&
                (i.rows === null ||
                  i.rows.every((row) => row.length === current.table.columns.length))
              : i.rows === null;
          if (!fits) return { ok: false, outcome: "invalid_input", refusal: "input_invalid" };
          const content: ResultItemContent =
            current.kind === "table"
              ? {
                  kind: "table",
                  table: {
                    columns: current.table.columns,
                    rows: [...current.table.rows, ...(i.rows ?? [])],
                  },
                }
              : { kind: "text", text: current.text + (i.text ?? "") };
          const appended = i.text !== null || i.rows !== null ? 1 : 0;
          const prior = existing.record;
          stored = {
            record: await record(
              run,
              itemId,
              prior,
              content,
              !i.close,
              prior.sections + appended,
              prior.createdAt,
            ),
            content,
            written: true,
          };
        }
        items.set(itemId, stored);
        return {
          ok: true,
          itemId,
          open: stored.record.open,
          sections: stored.record.sections,
          pageCount: stored.record.pageCount,
        };
      };
    },
    async closeRun(run) {
      const refs: Current_ResultItemRef[] = [];
      for (const itemId of writtenBy.get(run.runId) ?? []) {
        const stored = items.get(itemId)!;
        const r = stored.record;
        // Once per item: a follow-up's close never re-stamps an earlier sequence's items.
        if (!finalized.has(itemId)) {
          finalized.add(itemId);
          const final = { ...run, taint: joinRunTaint(r.taint, run.taint) };
          stored.record = await record(
            final,
            itemId,
            r,
            stored.content,
            false,
            r.sections,
            r.createdAt,
          );
        }
        refs.push({
          itemId,
          kind: r.kind,
          title: r.title,
          sizeBytes: stored.record.sizeBytes,
          pageCount: stored.record.pageCount,
        });
      }
      return Object.freeze(refs);
    },
    receive(parentRunId, result) {
      const set = received.get(parentRunId) ?? new Set<string>();
      for (const item of result.items) set.add(item.itemId);
      received.set(parentRunId, set);
    },
    readForCoordinator({ runId, itemId, page }) {
      return read(itemId, page, (item) =>
        coordinatorMayOpen(item, received.get(runId) ?? new Set()),
      );
    },
    readForTeammate({ callingRunId, brief, itemId, page }) {
      return read(itemId, page, (item) =>
        teammateMayOpen(item, brief, received.get(callingRunId) ?? new Set()),
      );
    },
    item(itemId) {
      return items.get(itemId)?.record ?? null;
    },
    get size() {
      return items.size;
    },
  };
}

/** What one scripted teammate's run did with a brief (the loop's facts, from code and SQL). */
export interface FakeTeammateRun {
  /** run.complete's child form, or null when the run ended without one. */
  readonly completion: Current_ToolInputRunComplete | null;
  readonly endReason: Current_AgentRunEndReason;
  readonly readTags: readonly Current_ReadTag[];
  readonly taint: Current_RunTaint;
  readonly created: readonly Current_TeammateCreatedRecord[];
  /** Findings in its plan's notes, kept when it ends without run.complete. */
  readonly recordedFindings?: readonly Current_TeammateFindingInput[];
  readonly unresolved?: readonly Current_TeammateUnresolvedSubject[];
  readonly plan?: Current_TeammatePlanProgress | null;
  readonly checkpointId?: string | null;
}
/** One scripted teammate: what its run does for a brief, with result.write for its items. */
export interface FakeTeammate {
  readonly installationId: string;
  readonly active: boolean;
  respond(
    brief: Current_TeammateBrief,
    tools: { readonly resultWrite: (input: unknown) => Promise<ResultWriteOutcome> },
  ): FakeTeammateRun | Promise<FakeTeammateRun>;
}
export type TeammateCallRefusal =
  | "input_invalid"
  | "teammate_unavailable"
  | "call_not_found"
  | "call_not_idle"
  | "retry_blocked"
  | "result_customer_tagged";
export type TeammateCallOutcome =
  | {
      readonly ok: true;
      readonly callId: string;
      readonly sequence: number;
      readonly result: Current_TeammateResult;
    }
  | { readonly ok: false; readonly refusal: TeammateCallRefusal }
  /** Nothing admitted: the job parks on credits (item 9) or checks in at 32 children (item 21). */
  | { readonly ok: false; readonly wait: "credits" | "children_checkin" };
/**
 * agent.cancel's outcome: an idle child is released at once; a running one is cancelled, and
 * its run ends stopped at its next boundary, keeping what it did (ADR-0041 item 21: a step
 * that began returns its recorded result). A released call is neither running nor idle.
 */
export type CancelOutcome =
  | { readonly ok: true; readonly state: "released" | "cancelled" }
  | { readonly ok: false; readonly refusal: "call_not_found" | "call_not_idle" };
export interface FakeTeammateRunner {
  /** agent.ask: one call or one follow-up, admitted and checked alone. */
  call(request: {
    readonly parentRunId: string;
    /** The calling Morrow run's taint at the call: it carries into the called run. */
    readonly callerTaint: Current_RunTaint;
    readonly toolUseId: string;
    /** agent.ask's input as Morrow wrote it. */
    readonly input: Current_ToolInputAgentAsk;
    /** The requester's own words, filled by code (null for a mandate episode). */
    readonly request: Current_TeammateRequest | null;
  }): Promise<TeammateCallOutcome>;
  /** agent.cancel: cancel a running call of this run, or release an idle one. */
  cancel(parentRunId: string, callId: string): CancelOutcome;
  /** Children admitted under one Morrow run's envelope so far (follow-ups add none). */
  children(parentRunId: string): number;
}

interface CallState {
  readonly callId: string;
  readonly parentRunId: string;
  readonly installationId: string;
  readonly runId: string;
  readonly taskId: string;
  state: "idle" | "running" | "released";
  /** agent.cancel reached the call while it ran: its run ends stopped and it is released. */
  cancelled: boolean;
  sequence: number;
  given: Current_TeammateRecordRef[];
  taint: Current_RunTaint;
}
const refKey = (r: { readonly kind: string; readonly id: string }) => r.kind + "\u0000" + r.id;

export function createFakeTeammateRunner(options: {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly teammates: readonly FakeTeammate[];
  readonly store: FakeResultItemStore;
  /** Whether the workspace balance covers this call's first hold at once (never waits). */
  readonly coversCall: (call: {
    readonly parentRunId: string;
    readonly installationId: string;
  }) => boolean;
  readonly now: () => string;
}): FakeTeammateRunner {
  const children = new Map<string, number>();
  const calls = new Map<string, CallState>();
  const unresolvedByParent = new Map<string, Current_TeammateUnresolvedSubject[]>();
  let next = 1;
  return {
    children: (parentRunId) => children.get(parentRunId) ?? 0,
    cancel(parentRunId, callId) {
      const call = calls.get(callId);
      if (!call || call.parentRunId !== parentRunId)
        return { ok: false, refusal: "call_not_found" };
      if (call.state === "running") {
        call.cancelled = true;
        return { ok: true, state: "cancelled" };
      }
      if (call.state !== "idle") return { ok: false, refusal: "call_not_idle" };
      call.state = "released";
      return { ok: true, state: "released" };
    },
    async call({ parentRunId, callerTaint, toolUseId, input, request }) {
      if (
        !agentAskValid(input) ||
        !runTaintValid(callerTaint) ||
        (request !== null && !validateCurrentDefinition("TeammateRequest", request))
      )
        return { ok: false, refusal: "input_invalid" };
      // A follow-up names a call of this run that is idle; a fresh call names a teammate.
      let call: CallState | null = null;
      if (input.followUpOf !== null) {
        const found = calls.get(input.followUpOf);
        if (!found || found.parentRunId !== parentRunId)
          return { ok: false, refusal: "call_not_found" };
        if (found.state !== "idle") return { ok: false, refusal: "call_not_idle" };
        call = found;
      }
      const installationId = call?.installationId ?? input.installationId!;
      const teammate = options.teammates.find((t) => t.installationId === installationId);
      if (!teammate || !teammate.active) return { ok: false, refusal: "teammate_unavailable" };
      // ADR-0041 item 23: nothing is dispatched over subjects with unknown outcomes.
      if (retryBlocked(input.brief.records, unresolvedByParent.get(parentRunId) ?? []) !== "ok")
        return { ok: false, refusal: "retry_blocked" };
      const count = children.get(parentRunId) ?? 0;
      if (call === null && count >= maximumChildrenPerEnvelope)
        return { ok: false, wait: "children_checkin" };
      if (!options.coversCall({ parentRunId, installationId }))
        return { ok: false, wait: "credits" };
      const brief = teammateBrief(input.brief, {
        request,
        mode: input.mode,
        followUpOf: input.followUpOf,
      });
      if (brief === null) return { ok: false, refusal: "input_invalid" };
      // Admitted: a fresh child counts now, before any wait, so parallel calls count alone.
      if (call === null) {
        children.set(parentRunId, count + 1);
        const n = next++;
        call = {
          callId: `call_fake_${n}`,
          parentRunId,
          installationId,
          runId: `run_call_${n}`,
          taskId: `task_call_${n}`,
          state: "running",
          cancelled: false,
          sequence: 1,
          given: [],
          taint: callerTaint,
        };
        calls.set(call.callId, call);
      } else {
        call.state = "running";
        call.sequence += 1;
      }
      const callId = call.callId;
      const seen = new Set(call.given.map(refKey));
      for (const r of brief.records)
        if (!seen.has(refKey(r))) {
          seen.add(refKey(r));
          call.given.push({ kind: r.kind, id: r.id });
        }
      // The call starts tainted when its caller is, and a follow-up keeps what the child read.
      const startTaint = joinRunTaint(call.taint, callerTaint);
      const child = call;
      const run = await teammate.respond(structuredClone(brief) as Current_TeammateBrief, {
        resultWrite: options.store.writerFor({
          runId: child.runId,
          readTags: [],
          taint: startTaint,
        }),
      });
      const runTaint = joinRunTaint(startTaint, run.taint);
      call.taint = runTaint;
      const written = await options.store.closeRun({
        runId: call.runId,
        readTags: run.readTags,
        taint: runTaint,
      });
      const facts = {
        organizationId: options.organizationId,
        workspaceId: options.workspaceId,
        parentRunId,
        toolUseId,
        callId,
        sequence: call.sequence,
        mode: input.mode,
        runId: call.runId,
        taskId: call.taskId,
        installationId,
        // A cancel that reached the running call stops it: whatever it did is kept as partial.
        endReason: call.cancelled ? ("stopped" as const) : run.endReason,
        doneCriteria: brief.doneCriteria.length,
        given: [...call.given],
        created: run.created,
        written,
        recordedFindings: run.recordedFindings ?? [],
        unresolved: run.unresolved ?? [],
        plan: run.plan ?? null,
        checkpointId: run.checkpointId ?? null,
        verifierVerdict: "not_run" as const,
        readTags: run.readTags,
        taint: runTaint,
        completedAt: options.now(),
      };
      const result = await buildTeammateResult(
        facts,
        run.completion,
        options.store.sinkFor({ runId: call.runId, readTags: run.readTags, taint: runTaint }),
      );
      call.state = call.cancelled ? "released" : "idle";
      if ((run.unresolved ?? []).length > 0)
        unresolvedByParent.set(parentRunId, [
          ...(unresolvedByParent.get(parentRunId) ?? []),
          ...run.unresolved!,
        ]);
      const accepted = acceptTeammateResult(result);
      if (accepted === "result_customer_tagged") return { ok: false, refusal: accepted };
      if (accepted !== "ok") throw Error("FAKE_RESULT_INVALID");
      options.store.receive(parentRunId, result);
      return { ok: true, callId, sequence: call.sequence, result };
    },
  };
}
