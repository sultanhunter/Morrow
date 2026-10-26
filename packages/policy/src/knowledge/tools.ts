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
import { screenModelWrittenSync } from "../customer-screen";
import { checkToolInput, toolEntry, type ToolContext } from "../tool-catalogue";
import { customerTagged, sourcesValid, storableText, unionTags } from "./rules";

// The two agent tools' code checks (PR 20; ADR-0027 item 2), run by the tool-call step after
// lease re-entry and replay and before the server-side command. The agent loop (PR 11) owns
// the step; these are its seam, driven by a fake caller in the tests and labs until it lands.
//   * knowledge.propose (workspace.knowledge.propose, execute) makes one pending proposal: it
//     grants nothing and changes no page; a person accepts or rejects it.
//   * notebook.write (workspace.notebook.write, execute) writes one entry in the run's own
//     installation's notebook.
// The run's read tags are the union of its tool results' tags, computed by the loop, never by
// a model; a run that read customer data (the support.case.read tag) can do neither. H9a
// (ADR-0041 item 31): the text the model wrote (a proposal's title, text and source values, a
// notebook entry's text) passes the customer identifier screen before the command; an email,
// phone, street address or customer id in it is refused as customer_data, and nothing of it is
// stored. Each refusal is a ToolRefusalCode; an input outside the tool's full definition is
// invalid_input.

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
export interface NotebookWriteArgs {
  readonly text: string;
  readonly readTags: readonly Current_ReadTag[];
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
  if (
    !screenModelWrittenSync("knowledge_proposal", {
      title: i.title,
      text: i.text,
      sources: i.sources.map((s) => s.value),
    }).ok
  )
    return refused("customer_data");
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

/** notebook.write's checks in code; on success, the server-side command's arguments. */
export function decideNotebookWrite(
  input: unknown,
  run: KnowledgeRunFacts,
): KnowledgeToolRefusal | { readonly ok: true; readonly args: NotebookWriteArgs } {
  const refusal = common("notebook.write", input, run);
  if (refusal) return refusal;
  const i = input as Current_ToolInputNotebookWrite;
  if (!storableText(i.text)) return invalidInput;
  if (!screenModelWrittenSync("notebook_entry", i.text).ok) return refused("customer_data");
  return Object.freeze({
    ok: true as const,
    args: Object.freeze({ text: i.text, readTags: run.readTags }),
  });
}
