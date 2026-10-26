import type {
  Current_ContextTaint,
  Current_KnowledgePageKind,
  Current_KnowledgeSource,
  Current_ReadTag,
  Current_ToolInputKnowledgePropose,
  Current_ToolInputNotebookWrite,
  Current_ToolRefusalCode,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { checkToolInput, toolEntry, type ToolContext } from "../tool-catalogue";
import {
  memoryLimits,
  memoryRefsValid,
  memoryRunFactsValid,
  memoryTextRefused,
  notebookEntryKinds,
  notebookTitleFrom,
  type MemoryRef,
  type MemoryRunFacts,
  type NotebookEntryKind,
} from "../memory/index";
import { customerTagged, sourcesValid, storableText, unionTags } from "./rules";

// The two agent tools' code checks (PR 20; ADR-0027 item 2), run by the tool-call step after
// lease re-entry and replay and before the server-side command. The agent loop (PR 11) owns
// the step; these are its seam, driven by a fake caller in the tests and labs until it lands.
//   * knowledge.propose (workspace.knowledge.propose, execute) makes one pending proposal: it
//     grants nothing and changes no page; a person accepts or rejects it.
//   * notebook.write (workspace.notebook.write, execute) adds, replaces or retires one entry in
//     the run's own agent's notebook (H12a, migration 0057: notebooks are keyed by agent
//     principal; ADR-0041 item 27).
// The run's read tags are the union of its tool results' tags, computed by the loop, never by
// a model; a run that read customer data (the support.case.read tag) can do neither. Each
// refusal is a ToolRefusalCode; an input outside the tool's full definition is invalid_input.

/** What the loop knows about the run making the call (server-held, never model output). */
export interface KnowledgeRunFacts {
  readonly context: ToolContext;
  /**
   * The union of the run's tool results' read tags so far: every result that put content in
   * the run's context (a knowledge.search hit's tags, the brand voice's, any other tool's),
   * added with withResultTags before the run's next tool call.
   */
  readonly readTags: readonly Current_ReadTag[];
  /** untrusted_external once the run consumed product text, mail, uploads or tool output. */
  readonly taint: Current_ContextTaint;
  /** docs/decisions/shop-knowledge-staging.json's agent_tools. */
  readonly agentTools: "on" | "off";
  /**
   * H12a: the run's memory facts (taint with its sources, output audience, source subjects,
   * whether it loaded person memory, and what it may read). notebook.write needs them; the
   * loop computes them, never a model. `taint` above must agree with `memory.taint`.
   */
  readonly memory?: MemoryRunFacts;
}
export type KnowledgeToolRefusal =
  | { readonly ok: false; readonly outcome: "refused"; readonly refusal: Current_ToolRefusalCode }
  | { readonly ok: false; readonly outcome: "invalid_input"; readonly refusal: "input_invalid" };
export interface KnowledgeProposeArgs {
  readonly pageId: string | null;
  readonly kind: Current_KnowledgePageKind;
  readonly title: string;
  readonly text: string;
  readonly sources: readonly Current_KnowledgeSource[];
  readonly readTags: readonly Current_ReadTag[];
  readonly taint: Current_ContextTaint;
}
/**
 * One notebook change (ADR-0041 item 24's notebook.write {op}). The v1.1 tool input carries only
 * a text, which is an add of a lesson titled from its first line; tool catalogue version 4 (H5)
 * hands the full operation to decideNotebookOperation.
 */
export type NotebookOperation =
  | {
      readonly op: "add";
      readonly kind: NotebookEntryKind;
      readonly title: string;
      readonly text: string;
      readonly derivedFrom: readonly MemoryRef[];
    }
  | {
      readonly op: "replace";
      readonly targetId: string;
      readonly kind: NotebookEntryKind;
      readonly title: string;
      readonly text: string;
      readonly derivedFrom: readonly MemoryRef[];
    }
  | { readonly op: "retire"; readonly targetId: string };
export interface NotebookWriteArgs {
  readonly operation: NotebookOperation;
  readonly readTags: readonly Current_ReadTag[];
  readonly memory: MemoryRunFacts;
}

/**
 * The run's facts once a tool result's content entered its context (ADR-0031 item 6: a run's
 * read tags are the union of its tool results' tags, and they only narrow). The loop calls it
 * with each result's tags (knowledgeSearchForRun's hits, listingsBrandVoice's page) before the
 * run's next tool call, so a later knowledge.propose or notebook.write carries at least the
 * tags of everything it may be based on. More than 24 distinct tags cannot be carried:
 * KNOWLEDGE_RUN_TAGS_OVERFLOW, and the step fails closed.
 */
export function withResultTags(
  run: KnowledgeRunFacts,
  tags: readonly Current_ReadTag[],
): KnowledgeRunFacts {
  if (
    !run ||
    !validateCurrentDefinition("ReadTags", run.readTags) ||
    !validateCurrentDefinition("ReadTags", tags)
  )
    throw Error("KNOWLEDGE_RUN_FACTS_INVALID");
  const readTags = unionTags(run.readTags, tags);
  if (readTags === null) throw Error("KNOWLEDGE_RUN_TAGS_OVERFLOW");
  return Object.freeze({ ...run, readTags });
}

const refused = (refusal: Current_ToolRefusalCode): KnowledgeToolRefusal =>
  Object.freeze({ ok: false, outcome: "refused", refusal });
const invalidInput: KnowledgeToolRefusal = Object.freeze({
  ok: false,
  outcome: "invalid_input",
  refusal: "input_invalid",
});
function common(
  tool: "knowledge.propose" | "notebook.write",
  input: unknown,
  run: KnowledgeRunFacts,
) {
  if (
    !run ||
    !validateCurrentDefinition("ReadTags", run.readTags) ||
    (run.taint !== "none" && run.taint !== "untrusted_external") ||
    (run.agentTools !== "on" && run.agentTools !== "off")
  )
    throw Error("KNOWLEDGE_RUN_FACTS_INVALID");
  if (run.agentTools !== "on") return refused("switch_off");
  if (!toolEntry(tool)!.contexts.includes(run.context)) return refused("not_offered");
  if (!checkToolInput(tool, input).ok) return invalidInput;
  if (customerTagged(run.readTags)) return refused("customer_data");
  return null;
}

/** knowledge.propose's checks in code; on success, the server-side command's arguments. */
export function decideKnowledgePropose(
  input: unknown,
  run: KnowledgeRunFacts,
): KnowledgeToolRefusal | { readonly ok: true; readonly args: KnowledgeProposeArgs } {
  const refusal = common("knowledge.propose", input, run);
  if (refusal) return refusal;
  const i = input as Current_ToolInputKnowledgePropose;
  if (!storableText(i.title) || !storableText(i.text) || !sourcesValid(i.sources))
    return invalidInput;
  return Object.freeze({
    ok: true as const,
    args: Object.freeze({
      pageId: i.pageId,
      kind: i.kind,
      title: i.title,
      text: i.text,
      sources: Object.freeze(i.sources.map((s) => Object.freeze({ kind: s.kind, value: s.value }))),
      readTags: run.readTags,
      taint: run.taint,
    }),
  });
}

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const textWithin = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  [...value].length >= 1 &&
  [...value].length <= max &&
  /\S/.test(value) &&
  storableText(value);
/** The closed shape of one notebook operation (H5's input contract becomes its validator). */
function operationValid(value: unknown): value is NotebookOperation {
  if (!plain(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  if (value.op === "retire")
    return (
      keys === "op,targetId" && typeof value.targetId === "string" && uuid.test(value.targetId)
    );
  const content =
    notebookEntryKinds.includes(value.kind as NotebookEntryKind) &&
    textWithin(value.title, memoryLimits.notebookTitleChars) &&
    textWithin(value.text, memoryLimits.notebookTextChars) &&
    memoryRefsValid(value.derivedFrom);
  if (value.op === "add") return keys === "derivedFrom,kind,op,text,title" && content;
  if (value.op === "replace")
    return (
      keys === "derivedFrom,kind,op,targetId,text,title" &&
      content &&
      typeof value.targetId === "string" &&
      uuid.test(value.targetId)
    );
  return false;
}
/** The memory refusals code decides before the definer (which holds the same rules). */
function memoryRefusal(
  memory: MemoryRunFacts,
  operation: NotebookOperation,
): KnowledgeToolRefusal | null {
  // A notebook is never written from a private Ask (ADR-0041 item 33: not offered there).
  if (memory.audience.kind === "principal") return refused("not_offered");
  // A run that loaded person memory never writes a notebook (item 29).
  if (memory.personMemoryLoaded) return refused("authority_denied");
  if (operation.op !== "retire" && memoryTextRefused(operation.title + "\n" + operation.text))
    return refused("customer_data");
  return null;
}
function memoryFacts(run: KnowledgeRunFacts): MemoryRunFacts {
  const memory = run.memory;
  if (
    !memoryRunFactsValid(memory) ||
    // The two taints agree: an untrusted context is a tainted memory and the reverse.
    (run.taint === "untrusted_external") !== memory.taint.kinds.includes("untrusted_external")
  )
    throw Error("KNOWLEDGE_RUN_FACTS_INVALID");
  return memory;
}
function decided(
  operation: NotebookOperation,
  run: KnowledgeRunFacts,
  memory: MemoryRunFacts,
): KnowledgeToolRefusal | { readonly ok: true; readonly args: NotebookWriteArgs } {
  const refusal = memoryRefusal(memory, operation);
  if (refusal) return refusal;
  return Object.freeze({
    ok: true as const,
    args: Object.freeze({ operation: Object.freeze(operation), readTags: run.readTags, memory }),
  });
}

/**
 * notebook.write's checks in code for the v1.1 input ({text}); on success, the server-side
 * command's arguments: an add of a lesson titled from its text's first line, with no sources.
 */
export function decideNotebookWrite(
  input: unknown,
  run: KnowledgeRunFacts,
): KnowledgeToolRefusal | { readonly ok: true; readonly args: NotebookWriteArgs } {
  const refusal = common("notebook.write", input, run);
  if (refusal) return refusal;
  const memory = memoryFacts(run);
  const i = input as Current_ToolInputNotebookWrite;
  if (!storableText(i.text)) return invalidInput;
  const title = notebookTitleFrom(i.text);
  if (!textWithin(title, memoryLimits.notebookTitleChars)) return invalidInput;
  return decided(
    { op: "add", kind: "lesson", title, text: i.text, derivedFrom: Object.freeze([]) },
    run,
    memory,
  );
}

/**
 * notebook.write's checks in code for one full operation (add, replace or retire, with its
 * sources): the seam tool catalogue version 4 (H5) calls once its input contract lands. The
 * same switch, context, customer and memory checks as decideNotebookWrite; the target and every
 * source must then pass the run's read predicates in the definer.
 */
export function decideNotebookOperation(
  operation: unknown,
  run: KnowledgeRunFacts,
): KnowledgeToolRefusal | { readonly ok: true; readonly args: NotebookWriteArgs } {
  if (
    !run ||
    !validateCurrentDefinition("ReadTags", run.readTags) ||
    (run.taint !== "none" && run.taint !== "untrusted_external") ||
    (run.agentTools !== "on" && run.agentTools !== "off")
  )
    throw Error("KNOWLEDGE_RUN_FACTS_INVALID");
  if (run.agentTools !== "on") return refused("switch_off");
  if (!toolEntry("notebook.write")!.contexts.includes(run.context)) return refused("not_offered");
  if (!operationValid(operation)) return invalidInput;
  if (customerTagged(run.readTags)) return refused("customer_data");
  return decided(operation, run, memoryFacts(run));
}
