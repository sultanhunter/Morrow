// Agent cards in code (ADR-0037 items 4 and 5; its implementation plan's PR 2). Pure: no I/O,
// clock or randomness, and Web Crypto only (no node:*), so the same rules run in Node and in
// the Workers. The agent-card authority packet (PR 3) builds the "Add to team" transaction on
// them; nothing here grants, stores or approves anything.
//
// - Morrow drafts with agent.propose: the model writes the name, purpose, instructions and
//   skill text and picks skills, tools and trigger kinds. Code derives and writes the rest
//   from those tools and server facts: capabilities and verbs, Shopify scopes, data classes,
//   the customer-data level, the store, run limits (no money cap, item 6), the model profile,
//   the Owner-only kinds and the taint.
// - The fixed catalogue only (item 5): never a human_only capability, workspace.task.delegate,
//   agents.* or any agent.* tool, and at launch never Level 2 customer data or support.* (nor
//   the inbound-mail trigger that carries customer mail).
// - A person may edit before approval: change the name, purpose and instructions, or remove
//   tools, triggers, skills or skill text. Each edit is a new revision with its editor; it
//   keeps the taint and never widens. Anything more is a new card.
// - The "Add to team" document binds the card's digest and revision, the actor and a
//   standalone session for 5 minutes.
import type {
  Current_AddToTeamDocument,
  Current_AgentPackage,
  Current_AgentProposal,
  Current_CapabilityVerbs,
  Current_HumanActorRef,
  Current_ModelProfile,
  Current_RunTaint,
  Current_ToolInputAgentPropose,
  Current_TriggerKind,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import catalogue from "../../../docs/contracts/capabilities.json";
import { canonicalText, sha256Hex } from "./projects/digest";
import {
  type PermissionVerb,
  type ToolName,
  teammateResultTool,
  toolCatalogue,
  toolEntry,
} from "./tool-catalogue";

const capabilities = new Map(catalogue.capabilities.map((c) => [c.id, c]));
const verbOrder: readonly PermissionVerb[] = [
  "view",
  "propose",
  "approve",
  "execute",
  "delegate",
  "administer",
];
/** At most this many active workspace-created agents per workspace at launch (item 5). */
export const workspaceAgentLimit = 10;
/** An "Add to team" document's life (item 4). */
export const addToTeamDocumentSeconds = 300;
/** The trigger kinds a card may name: the closed list less Support's inbound mail. */
export const cardTriggerKinds: readonly Current_TriggerKind[] = Object.freeze([
  "schedule",
  "shopify_event",
  "monitor",
  "look_for_work",
]);

export type CardRefusal = "input_invalid" | "card_tool_excluded";

/**
 * Whether a capability may ever be on a card (item 5): not human_only, not delegation or
 * agents.*, not support.*.
 */
export function cardCapabilityAllowed(capabilityId: unknown): boolean {
  if (typeof capabilityId !== "string") return false;
  const capability = capabilities.get(capabilityId);
  return (
    capability !== undefined &&
    capability.executor !== "human_only" &&
    capabilityId !== "workspace.task.delegate" &&
    !capabilityId.startsWith("agents.") &&
    !capabilityId.startsWith("support.")
  );
}
/**
 * Whether a card may pick a tool (item 5): one an installed agent may be offered (a hand-off,
 * a mandate run or a call), never an agent.* tool, and on an allowed capability. The
 * teammate result tool is code's to add, never the model's to pick.
 */
export function cardToolAllowed(name: unknown): boolean {
  const tool = toolEntry(name);
  return (
    tool !== null &&
    !tool.name.startsWith("agent.") &&
    tool.name !== teammateResultTool &&
    tool.contexts.some((c) => c === "routed" || c === "mandate" || c === "call") &&
    cardCapabilityAllowed(tool.capabilityId)
  );
}

/** What code derives from a card's tools (item 4). */
export interface CardGrants {
  readonly tools: readonly ToolName[];
  readonly capabilities: readonly Current_CapabilityVerbs[];
  readonly optionalScopes: readonly "read_orders"[];
  readonly dataClasses: readonly Current_AgentProposal["dataClasses"][number][];
  readonly customerData: "none" | "level1";
  readonly computer: boolean;
  readonly ownerOnly: readonly Current_AgentProposal["ownerOnly"][number][];
}
const dataClassOf = new Set([
  "catalog.products.read",
  "inventory.levels.read",
  "orders.read",
  "workspace.knowledge.read",
  "workspace.artifact.read",
]);
/**
 * A card's derived grants from the tools it picked, with the teammate result tool added so
 * every created teammate can be called: tools in catalogue order; each tool's capability and
 * verb, grouped by capability in id order with verbs in their fixed order; read_orders for
 * order reads; the read tools' data classes; level1 for order aggregates; the four Owner-only
 * kinds (an external_write capability even with propose only, order or customer reads, spend,
 * communication). Throws on a tool a card may not hold.
 */
export function deriveCardGrants(picked: readonly string[]): CardGrants {
  if (!Array.isArray(picked) || picked.length < 1 || new Set(picked).size !== picked.length)
    throw new AgentCardError("input_invalid");
  if (picked.some((name) => !cardToolAllowed(name))) throw new AgentCardError("card_tool_excluded");
  const chosen = new Set<string>([...picked, teammateResultTool]);
  const tools = toolCatalogue.filter((t) => chosen.has(t.name));
  const verbs = new Map<string, Set<PermissionVerb>>();
  for (const tool of tools) {
    const set = verbs.get(tool.capabilityId) ?? new Set<PermissionVerb>();
    set.add(tool.verb);
    verbs.set(tool.capabilityId, set);
  }
  const ids = [...verbs.keys()].sort();
  const capabilityRows = ids.map((capabilityId) => ({
    capabilityId,
    verbs: verbOrder.filter((v) => verbs.get(capabilityId)!.has(v)),
  }));
  const effects = new Set(ids.map((id) => capabilities.get(id)!.effect));
  const ordersRead = ids.includes("orders.read");
  const ownerOnly: CardGrants["ownerOnly"][number][] = [];
  if (effects.has("external_write")) ownerOnly.push("store_effect");
  if (ordersRead) ownerOnly.push("orders_or_customer");
  if (effects.has("spend")) ownerOnly.push("spend");
  if (effects.has("communication")) ownerOnly.push("communication");
  return Object.freeze({
    tools: Object.freeze(tools.map((t) => t.name)),
    capabilities: Object.freeze(capabilityRows),
    optionalScopes: Object.freeze(ordersRead ? (["read_orders"] as const) : []),
    dataClasses: Object.freeze(
      ids.filter((id) => dataClassOf.has(id)) as CardGrants["dataClasses"][number][],
    ),
    customerData: ordersRead ? "level1" : "none",
    computer: tools.some((t) => t.family === "computer"),
    ownerOnly: Object.freeze(ownerOnly),
  });
}

export class AgentCardError extends Error {
  constructor(readonly code: CardRefusal) {
    super(code);
    this.name = "AgentCardError";
  }
}

/** A first-party skill a card may pick, as the server knows it. */
export interface CardSkill {
  readonly id: string;
  readonly digest: string;
  readonly eligibleForWorkspaceAgents: boolean;
  /** The tools its skill.json declares: a skill never adds a tool. */
  readonly tools: readonly string[];
}
/** The server facts a card is drafted with; never from the model. */
export interface CardFacts {
  readonly cardId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string;
  readonly connectionId: string;
  readonly runId: string;
  readonly requester: Current_HumanActorRef;
  readonly skills: readonly CardSkill[];
  readonly runLimits: Current_AgentProposal["runLimits"];
  /** The workspace's default for new teammates (the former specialist default). */
  readonly modelProfile: Current_ModelProfile;
  /** The drafting run's taint: a card keeps it through every edit and approval. */
  readonly taint: Current_RunTaint;
  readonly at: string;
}

const freezeDeep = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};
const pinSkills = (skillIds: readonly string[], facts: CardFacts, tools: readonly string[]) => {
  const pinned = [];
  for (const id of skillIds) {
    const skill = facts.skills.find((s) => s.id === id);
    if (!skill || !skill.eligibleForWorkspaceAgents) throw new AgentCardError("input_invalid");
    if (skill.tools.some((t) => !tools.includes(t))) throw new AgentCardError("input_invalid");
    pinned.push({ id: skill.id, digest: skill.digest });
  }
  return pinned;
};

/**
 * AgentProposal@1 revision 1 from agent.propose's recorded input and the server's facts, or a
 * refusal. input_invalid: outside ToolInputAgentPropose, an unknown or ineligible skill, a
 * skill that declares a tool the card does not pick, or a trigger outside cardTriggerKinds;
 * card_tool_excluded: a tool no card may hold (item 5).
 */
export function draftAgentCard(
  input: unknown,
  facts: CardFacts,
):
  | { readonly ok: true; readonly card: Current_AgentProposal }
  | { readonly ok: false; readonly refusal: CardRefusal } {
  if (!validateCurrentDefinition("ToolInputAgentPropose", input))
    return { ok: false, refusal: "input_invalid" };
  const draft = input as Current_ToolInputAgentPropose;
  try {
    if (draft.triggerKinds.some((k) => !cardTriggerKinds.includes(k)))
      throw new AgentCardError("input_invalid");
    const grants = deriveCardGrants(draft.tools);
    const card: Current_AgentProposal = {
      schemaVersion: 1,
      cardId: facts.cardId,
      revision: 1,
      organizationId: facts.organizationId,
      workspaceId: facts.workspaceId,
      storeId: facts.storeId,
      connectionId: facts.connectionId,
      origin: "workspace",
      draftedBy: { runId: facts.runId, requester: { ...facts.requester } },
      editedBy: null,
      name: draft.name,
      purpose: draft.purpose,
      instructions: draft.instructions,
      skillTexts: draft.skillTexts.map((s) => ({ title: s.title, body: s.body })),
      skills: pinSkills(draft.skillIds, facts, grants.tools),
      tools: [...grants.tools],
      capabilities: grants.capabilities.map((c) => ({ ...c, verbs: [...c.verbs] })),
      optionalScopes: [...grants.optionalScopes],
      dataClasses: [...grants.dataClasses],
      customerData: grants.customerData,
      computer: grants.computer,
      triggerKinds: cardTriggerKinds.filter((k) => draft.triggerKinds.includes(k)),
      runLimits: { ...facts.runLimits },
      modelProfile: { ...facts.modelProfile },
      ownerOnly: [...grants.ownerOnly],
      taint: {
        contextTaint: facts.taint.contextTaint,
        sources: facts.taint.sources.map((s) => ({ ...s })),
      },
      draftedAt: facts.at,
      revisedAt: facts.at,
    };
    if (!validateCurrentDefinition("AgentProposal", card))
      return { ok: false, refusal: "input_invalid" };
    return { ok: true, card: freezeDeep(card) };
  } catch (error) {
    if (error instanceof AgentCardError) return { ok: false, refusal: error.code };
    throw error;
  }
}

/** The card's digest: SHA-256 of its RFC 8785 text (every field is bound). */
export async function agentCardDigest(card: Current_AgentProposal): Promise<string> {
  return sha256Hex(canonicalText(card));
}

/** A person's edit before approval (item 4): changes to words, or removals only. */
export interface CardEdit {
  readonly name?: string;
  readonly purpose?: string;
  readonly instructions?: string;
  readonly removeTools?: readonly string[];
  readonly removeTriggerKinds?: readonly string[];
  readonly removeSkillIds?: readonly string[];
  /** Indexes into skillTexts. */
  readonly removeSkillTexts?: readonly number[];
}
const editKeys = new Set([
  "name",
  "purpose",
  "instructions",
  "removeTools",
  "removeTriggerKinds",
  "removeSkillIds",
  "removeSkillTexts",
]);
/**
 * The next revision of a card after a person's edit, or input_invalid: a key outside CardEdit
 * (there is no edit that adds: an addition is a new card and a new approval), removing a tool
 * the card does not hold, the teammate result tool, every picked tool, or a tool a kept skill
 * declares; or a value outside AgentProposal@1. Grants are derived again from the remaining
 * tools, so an edit only narrows; the taint, store, limits and model stay.
 */
export function reviseAgentCard(
  card: Current_AgentProposal,
  edit: CardEdit,
  editor: Current_HumanActorRef,
  at: string,
  skillFacts: readonly CardSkill[],
):
  | { readonly ok: true; readonly card: Current_AgentProposal }
  | { readonly ok: false; readonly refusal: CardRefusal } {
  if (
    !edit ||
    typeof edit !== "object" ||
    Object.keys(edit).some((key) => !editKeys.has(key)) ||
    [edit.removeTools, edit.removeTriggerKinds, edit.removeSkillIds, edit.removeSkillTexts].some(
      (list) => list !== undefined && !Array.isArray(list),
    )
  )
    return { ok: false, refusal: "input_invalid" };
  const remove = (list: readonly string[] | undefined) => new Set(list ?? []);
  const tools = remove(edit.removeTools);
  const triggers = remove(edit.removeTriggerKinds);
  const skills = remove(edit.removeSkillIds);
  const texts = new Set(edit.removeSkillTexts ?? []);
  if (
    [...tools].some((t) => !card.tools.includes(t as ToolName) || t === teammateResultTool) ||
    [...triggers].some((k) => !card.triggerKinds.includes(k as Current_TriggerKind)) ||
    [...skills].some((s) => !card.skills.some((p) => p.id === s)) ||
    [...texts].some((i) => !Number.isInteger(i) || i < 0 || i >= card.skillTexts.length)
  )
    return { ok: false, refusal: "input_invalid" };
  const picked = card.tools.filter((t) => t !== teammateResultTool && !tools.has(t));
  if (picked.length === 0) return { ok: false, refusal: "input_invalid" };
  let grants: CardGrants;
  try {
    grants = deriveCardGrants(picked);
  } catch (error) {
    if (error instanceof AgentCardError) return { ok: false, refusal: error.code };
    throw error;
  }
  const keptSkills = card.skills.filter((s) => !skills.has(s.id));
  const next: Current_AgentProposal = {
    ...structuredClone(card),
    revision: card.revision + 1,
    editedBy: { ...editor },
    name: edit.name ?? card.name,
    purpose: edit.purpose ?? card.purpose,
    instructions: edit.instructions ?? card.instructions,
    skillTexts: card.skillTexts.filter((_, i) => !texts.has(i)).map((s) => ({ ...s })),
    skills: keptSkills.map((s) => ({ ...s })),
    tools: [...grants.tools],
    capabilities: grants.capabilities.map((c) => ({ ...c, verbs: [...c.verbs] })),
    optionalScopes: [...grants.optionalScopes],
    dataClasses: [...grants.dataClasses],
    customerData: grants.customerData,
    computer: grants.computer,
    triggerKinds: card.triggerKinds.filter((k) => !triggers.has(k)),
    ownerOnly: [...grants.ownerOnly],
    revisedAt: at,
  };
  if (!validateCurrentDefinition("AgentProposal", next) || !cardSkillsWithinTools(next, skillFacts))
    return { ok: false, refusal: "input_invalid" };
  return { ok: true, card: freezeDeep(next) };
}
/** Whether every skill kept on a card declares only tools the card still holds. */
export function cardSkillsWithinTools(
  card: Current_AgentProposal,
  skills: readonly CardSkill[],
): boolean {
  return card.skills.every((pinned) => {
    const skill = skills.find((s) => s.id === pinned.id && s.digest === pinned.digest);
    return skill !== undefined && skill.tools.every((t) => card.tools.includes(t as ToolName));
  });
}

/**
 * The "Add to team" document (AddToTeamDocument@1, item 4): the card's digest, revision and
 * derived grants, bound to the actor and a standalone-workspace session, for 5 minutes. The
 * actor must be a person in the card's workspace; the review path is PR 3's to decide.
 */
export function addToTeamDocument(
  card: Current_AgentProposal,
  cardDigest: string,
  binding: {
    readonly documentId: string;
    readonly actor: Current_HumanActorRef;
    readonly sessionDigest: string;
    readonly review: Current_AddToTeamDocument["review"];
    readonly issuedAt: string;
  },
): Current_AddToTeamDocument | null {
  const issued = Date.parse(binding.issuedAt);
  if (
    binding.actor.organizationId !== card.organizationId ||
    binding.actor.workspaceId !== card.workspaceId ||
    !Number.isFinite(issued)
  )
    return null;
  const document: Current_AddToTeamDocument = {
    schemaVersion: 1,
    documentId: binding.documentId,
    organizationId: card.organizationId,
    workspaceId: card.workspaceId,
    actor: { ...binding.actor },
    sessionDigest: binding.sessionDigest,
    host: "standalone",
    cardId: card.cardId,
    cardRevision: card.revision,
    cardDigest,
    storeId: card.storeId,
    tools: [...card.tools],
    capabilities: card.capabilities.map((c) => ({ ...c, verbs: [...c.verbs] })),
    optionalScopes: [...card.optionalScopes],
    dataClasses: [...card.dataClasses],
    customerData: card.customerData,
    triggerKinds: [...card.triggerKinds],
    runLimits: { ...card.runLimits },
    modelProfile: { ...card.modelProfile },
    ownerOnly: [...card.ownerOnly],
    taint: {
      contextTaint: card.taint.contextTaint,
      sources: card.taint.sources.map((s) => ({ ...s })),
    },
    review: binding.review,
    issuedAt: binding.issuedAt,
    expiresAt: new Date(issued + addToTeamDocumentSeconds * 1000).toISOString(),
  };
  return validateCurrentDefinition("AddToTeamDocument", document) ? freezeDeep(document) : null;
}
/** Whether a document is still usable at a time (unexpired; the store consumes it once). */
export function addToTeamDocumentLive(document: Current_AddToTeamDocument, now: string): boolean {
  const t = Date.parse(now);
  return (
    Number.isFinite(t) && t >= Date.parse(document.issuedAt) && t < Date.parse(document.expiresAt)
  );
}

/** A workspace package id: workspace.<lower-case word>, server-assigned. */
export const workspacePackageId = /^workspace\.[a-z][a-z0-9_]{0,40}$/;
/**
 * The AgentPackage@1 an approved card becomes (origin workspace, kind installed): its
 * instructions and skill text, roleTextDigest the SHA-256 of the instructions' RFC 8785 text,
 * the card's tools, capabilities, scopes, triggers and customer-data level, and the card's
 * model as the one offered entry. No eval digest: the review gate stays (item 4).
 */
export async function workspacePackageFromCard(
  card: Current_AgentProposal,
  packageId: string,
): Promise<Current_AgentPackage | null> {
  if (!workspacePackageId.test(packageId)) return null;
  const profile = { model: card.modelProfile.model, effort: card.modelProfile.effort };
  const pkg: Current_AgentPackage = {
    schemaVersion: 1,
    id: packageId,
    revision: 1,
    kind: "installed",
    origin: "workspace",
    title: card.name,
    roleTextDigest: await sha256Hex(canonicalText(card.instructions)),
    instructions: card.instructions,
    skillTexts: card.skillTexts.map((s) => ({ ...s })),
    skills: card.skills.map((s) => ({ ...s })),
    tools: [...card.tools],
    capabilities: card.capabilities.map((c) => ({ ...c, verbs: [...c.verbs] })),
    optionalScopes: [...card.optionalScopes],
    triggerKinds: [...card.triggerKinds],
    customerData: card.customerData,
    computer: card.computer,
    offeredProfiles: [profile],
    defaultProfile: { ...profile },
    evalDigest: null,
  };
  return validateCurrentDefinition("AgentPackage", pkg) ? freezeDeep(pkg) : null;
}
