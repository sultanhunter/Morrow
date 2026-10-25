// Deterministic fakes of the teammate-call seams (ADR-0037 item 3(a); its implementation
// plan's PR 2), so the loop (PR 4), Morrow's tools (PR 5), the Team page (PR 6) and the evals
// (PR 9) build against them before any table or Workflow exists. No I/O, clock or randomness:
// ids count up, times come from the caller, and every rule is teammates.ts's, so a fake cannot
// drift from the code PR 4 runs. tests/teammates.test.mjs holds their conformance tests.
//
// - The fake result-item store keeps items in memory with their producing run, read tags and
//   taint, records which results each Morrow run received, and opens an item for Morrow or for
//   a called teammate only under coordinatorMayOpen or teammateMayOpen. An unknown id reads as
//   not received, so the store never says whether another run's item exists.
// - The fake teammate runner admits each call alone: an active teammate, the kernel's 32
//   children per envelope, and the workspace balance (credits only: the caller's coversCall
//   answers whether the call's hold fits at once; there is no money cap). Each call is a
//   fresh run, the same teammate again included; parallel calls each get their own run. The
//   called run starts with the calling run's taint and joins its own (joinRunTaint), so its
//   items and its result carry both. It builds TeammateResult@1 with buildTeammateResult, so
//   large output becomes items, and a customer-tagged result never reaches Morrow.
import type {
  Current_AgentRunEndReason,
  Current_ReadTag,
  Current_ResultItem,
  Current_ResultItemPage,
  Current_RunTaint,
  Current_TeammateBrief,
  Current_TeammateCreatedRecord,
  Current_TeammateResult,
  Current_ToolInputResultSubmit,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { canonicalText, sha256Hex } from "./projects/digest";
import {
  acceptTeammateResult,
  buildTeammateResult,
  coordinatorMayOpen,
  type ItemOpenRefusal,
  type ResultItemContent,
  type ResultItemSink,
  joinRunTaint,
  resultItemPage,
  teammateMayOpen,
} from "./teammates";

/** The kernel's bound on children per envelope (ADR-0037 item 3: unchanged). */
export const maximumChildrenPerEnvelope = 32;

export type ItemReadOutcome =
  | { readonly ok: true; readonly page: Current_ResultItemPage }
  | { readonly ok: false; readonly refusal: ItemOpenRefusal | "page_out_of_range" };

export interface FakeResultItemStore {
  /** A sink for one producing run: each item takes the run's read tags and taint. */
  sinkFor(run: {
    readonly runId: string;
    readonly readTags: readonly Current_ReadTag[];
    readonly taint: Current_RunTaint;
  }): ResultItemSink;
  /** Morrow's run received this result: its listed items become openable for that run. */
  receive(parentRunId: string, result: Current_TeammateResult): void;
  /** agent.result.read for Morrow's run. */
  readForCoordinator(request: {
    readonly runId: string;
    readonly itemId: string;
    readonly page: number;
  }): ItemReadOutcome;
  /** A called or handed-off teammate opening an item its brief names. */
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

export function createFakeResultItemStore(options: {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly now: () => string;
}): FakeResultItemStore {
  const items = new Map<string, { record: Current_ResultItem; content: ResultItemContent }>();
  const received = new Map<string, Set<string>>();
  let next = 1;
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
        content: stored.content,
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
        const record: Current_ResultItem = {
          schemaVersion: 1,
          itemId,
          organizationId: options.organizationId,
          workspaceId: options.workspaceId,
          runId: run.runId,
          kind: draft.kind,
          mediaType: draft.mediaType,
          title: draft.title,
          sizeBytes: draft.sizeBytes,
          pageCount: draft.pageCount,
          contentDigest: await sha256Hex(canonicalText(draft.content)),
          readTags: run.readTags.map((t) => ({ ...t })),
          taint: {
            contextTaint: run.taint.contextTaint,
            sources: run.taint.sources.map((s) => ({ ...s })),
          },
          createdAt: options.now(),
          expiresAt: null,
        };
        if (!validateCurrentDefinition("ResultItem", record)) throw Error("FAKE_ITEM_INVALID");
        items.set(itemId, { record: Object.freeze(record), content: draft.content });
        return itemId;
      };
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

/** One scripted teammate: what its run returns for a brief. */
export interface FakeTeammate {
  readonly installationId: string;
  readonly active: boolean;
  respond(brief: Current_TeammateBrief): {
    readonly submit: Current_ToolInputResultSubmit | null;
    readonly endReason: Current_AgentRunEndReason;
    readonly readTags: readonly Current_ReadTag[];
    readonly taint: Current_RunTaint;
    readonly created: readonly Current_TeammateCreatedRecord[];
  };
}
export type TeammateCallRefusal =
  | "input_invalid"
  | "teammate_unavailable"
  | "children_limit"
  | "insufficient_credits"
  | "result_customer_tagged";
export type TeammateCallOutcome =
  | { readonly ok: true; readonly result: Current_TeammateResult }
  | { readonly ok: false; readonly refusal: TeammateCallRefusal };
export interface FakeTeammateRunner {
  /** agent.ask: one call, admitted and checked alone. */
  call(request: {
    readonly parentRunId: string;
    /** The calling Morrow run's taint at the call: it carries into the called run. */
    readonly callerTaint: Current_RunTaint;
    readonly toolUseId: string;
    readonly installationId: string;
    readonly brief: Current_TeammateBrief;
  }): Promise<TeammateCallOutcome>;
  /** Children admitted under one Morrow run's envelope so far. */
  children(parentRunId: string): number;
}

export function createFakeTeammateRunner(options: {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly teammates: readonly FakeTeammate[];
  readonly store: FakeResultItemStore;
  /** Whether the workspace balance covers this call's hold at once (never waits). */
  readonly coversCall: (call: {
    readonly parentRunId: string;
    readonly installationId: string;
  }) => boolean;
  readonly now: () => string;
}): FakeTeammateRunner {
  const children = new Map<string, number>();
  let next = 1;
  return {
    children: (parentRunId) => children.get(parentRunId) ?? 0,
    async call({ parentRunId, callerTaint, toolUseId, installationId, brief }) {
      if (
        !validateCurrentDefinition("ToolInputAgentAsk", { installationId, brief }) ||
        !validateCurrentDefinition("RunTaint", callerTaint)
      )
        return { ok: false, refusal: "input_invalid" };
      const teammate = options.teammates.find((t) => t.installationId === installationId);
      if (!teammate || !teammate.active) return { ok: false, refusal: "teammate_unavailable" };
      const count = children.get(parentRunId) ?? 0;
      if (count >= maximumChildrenPerEnvelope) return { ok: false, refusal: "children_limit" };
      if (!options.coversCall({ parentRunId, installationId }))
        return { ok: false, refusal: "insufficient_credits" };
      // Admitted: the child counts now, before any wait, so parallel calls are counted alone.
      children.set(parentRunId, count + 1);
      const n = next++;
      const run = teammate.respond(structuredClone(brief) as Current_TeammateBrief);
      // The call starts tainted when its caller is (ADR-0037 item 3(a)): taint only joins.
      const taint = joinRunTaint(callerTaint, run.taint);
      const facts = {
        organizationId: options.organizationId,
        workspaceId: options.workspaceId,
        parentRunId,
        toolUseId,
        runId: `run_call_${n}`,
        taskId: `task_call_${n}`,
        installationId,
        endReason: run.endReason,
        created: run.created,
        readTags: run.readTags,
        taint,
        completedAt: options.now(),
      };
      const result = await buildTeammateResult(
        facts,
        run.submit,
        options.store.sinkFor({ runId: facts.runId, readTags: run.readTags, taint }),
      );
      const accepted = acceptTeammateResult(result);
      if (accepted === "result_customer_tagged") return { ok: false, refusal: accepted };
      if (accepted !== "ok") throw Error("FAKE_RESULT_INVALID");
      options.store.receive(parentRunId, result);
      return { ok: true, result };
    },
  };
}
