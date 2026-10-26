import { canonicalJson } from "../digest.js";
import type { LeaseStep } from "../runtime/leases.js";
import type { AgentRunState, RecordKind, ToolRefusal } from "./steps.js";

// The tool dispatch seam of the agent loop (ADR-0027 items 2 and 3). The runner calls a
// handler only after the call's input passed its full ToolInput validation, its ids are in
// the run's scope and the authority decision allowed it in code. A handler names the one
// effect its tool has, inside Morrow: a read, or an internal write keyed by the call's
// tool_use id so that a replayed step finds its first record (never a second write). No
// handler has an external effect: a change to the store is a digest-bound proposal for the
// gateway (proposal.listing, with Listings on the runner), approved exactly by a person.
//
// This build composes inbox.ask (the durable question) in the orchestrator. The other tools
// are each another PR's: knowledge.search (PR 20), work.read, message.post, suggestion.create
// and report.write (T6 and PR 15's Inbox), products.read and proposal.listing (Listings on the
// runner, which also adds run_turns' store-content cleanup handler before any store text
// enters a turn). A tool without a handler is never offered (admission's available tools),
// and a call to one is refused not_offered.

export type ToolDispatch =
  | {
      readonly outcome: "ok";
      /** The result as plain JSON (rendered as wrapped data, at most 8 KiB). */
      readonly data: unknown;
      /** Whether the result carries outside content (product, email, upload text). */
      readonly untrusted: boolean;
      /** An internal write's first record (the same on replay). */
      readonly record: { readonly kind: RecordKind; readonly id: string } | null;
      /** inbox.ask: the run waits for the requester's answer after this turn. */
      readonly asked?: true;
    }
  | {
      readonly outcome: "refused";
      readonly refusal: Exclude<ToolRefusal, "input_invalid">;
    }
  | { readonly outcome: "tool_outcome_unknown" };
export interface ToolDispatchContext {
  readonly run: AgentRunState;
  readonly toolUseId: string;
  /** The input, valid against its tool's full ToolInput definition. */
  readonly input: unknown;
  /** The call began in an earlier attempt of this step (a crash): replay by the record. */
  readonly resumed: boolean;
  /**
   * One transaction under the run lease. An internal write runs its definer here; a refused
   * lease is `interrupted` (the stop or the lease's end reaches the runner).
   */
  lease<T>(body: (step: LeaseStep) => Promise<T>): Promise<T | "interrupted">;
}
export interface ToolHandler {
  readonly tool: string;
  dispatch(context: ToolDispatchContext): Promise<ToolDispatch | "interrupted">;
}
export interface ToolHandlers {
  /** The tools this build can dispatch, in no particular order. */
  available(): readonly string[];
  get(tool: string): ToolHandler | null;
}
export function createToolHandlers(handlers: readonly ToolHandler[]): ToolHandlers {
  const map = new Map<string, ToolHandler>();
  for (const h of handlers) {
    if (map.has(h.tool)) throw Error("LOOP_TOOL_HANDLER_DUPLICATE");
    map.set(h.tool, h);
  }
  return Object.freeze({
    available: () => Object.freeze([...map.keys()]),
    get: (tool: string) => map.get(tool) ?? null,
  });
}

/**
 * inbox.ask (workspace.question.request): one question to the run's requester (never anyone
 * else: the definer takes no recipient), at most the run's questions limit; the same call
 * again returns its first question. The run then waits durably for the answer.
 */
export const inboxAskHandler: ToolHandler = Object.freeze({
  tool: "inbox.ask",
  async dispatch(context: ToolDispatchContext): Promise<ToolDispatch | "interrupted"> {
    const input = context.input as { question: string; choices: string[] };
    const asked = await context.lease((step) =>
      step.loop.questionAsk(context.toolUseId, input.question, canonicalJson(input.choices)),
    );
    if (asked === "interrupted") return "interrupted";
    if (asked.outcome === "question_limit")
      return Object.freeze({ outcome: "refused" as const, refusal: "question_limit" as const });
    if (asked.outcome !== "asked" && asked.outcome !== "replay")
      return Object.freeze({ outcome: "refused" as const, refusal: "run_closed" as const });
    return Object.freeze({
      outcome: "ok" as const,
      data: { questionId: asked.questionId, status: "waiting_for_answer" },
      untrusted: false,
      record: Object.freeze({ kind: "question" as const, id: asked.questionId }),
      asked: true as const,
    });
  },
});
/** The handlers the orchestrator composes in this build. */
export const builtInToolHandlers: readonly ToolHandler[] = Object.freeze([inboxAskHandler]);
