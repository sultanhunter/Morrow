import type { CapabilityId } from "@morrow/contracts";
import { createAgentAuthorityService } from "@morrow/policy/agent-authority";
import { listingFieldPaths, storeResource } from "@morrow/policy/store-resource";
import { createBillingFactsReader } from "../billing/facts.js";
import { createLeaseDelegationReader } from "../agents/delegation-reader.js";
import type { LeaseStep } from "../runtime/leases.js";
import type { AgentRunState, ToolRefusal } from "./steps.js";

// Every tool call's authority, decided in code at call time (ADR-0027 item 2; CLAUDE.md:
// permission checks happen in code, outside model prompts). For a routed run the decision
// is decideDelegation over the facts read again in this step (delegation_facts and the
// workspace's billing rows), which intersects: the requester's live grants (with delegate),
// the delegation envelope on the requester's task and the Coordinator's hop, the
// installation's grants and scope, the installation owner's current authority, live policy
// (the policy revision), the store connection (providerAllowed: the association is current
// and no stop blocks the run) and the entitlement. Any one failing refuses the call; missing
// or malformed facts refuse it too. A stop or an ended lease never reaches here: the lease
// entry refuses first. Model text never names a capability, a scope, a recipient or a limit:
// the operation is built from the tool's catalogue pair and the run's own store.

export interface ToolOperation {
  readonly capabilityId: string;
  readonly verb: "view" | "propose" | "execute" | "delegate";
  readonly fields: readonly string[];
}
// The fields each tool's operation names (the kernel requires at least one, inside the
// envelope's, the installation's and every grant's field scope). A tool with no entry has no
// field scope in this build: its calls are refused before the kernel (authority_denied), and
// its own PR adds it with its handler.
const toolFields: Readonly<Record<string, (input: unknown) => readonly string[] | null>> =
  Object.freeze({
    // The listing fields, as the Listings run reads and proposes them.
    "products.read": () => [...listingFieldPaths],
    "proposal.listing": (input) => {
      const changes = (input as { changes?: unknown }).changes;
      if (!Array.isArray(changes)) return null;
      const fields = new Set<string>();
      for (const c of changes as Record<string, unknown>[]) {
        if (c.title !== null) fields.add("title");
        if (c.descriptionHtml !== null) fields.add("descriptionHtml");
        if (c.seo !== null) fields.add("seo.title").add("seo.description");
        if (c.tags !== null) fields.add("tags");
      }
      return fields.size ? [...fields].sort() : null;
    },
    // The work API's question.request and message.post rules (work-permissions.ts).
    "inbox.ask": () => ["answerSchema", "question", "respondentId", "taskId"],
    "message.post": () => ["parts", "replyToMessageId"],
  });
/** The operation of one call: the tool's catalogue pair on the run's store, its fields. */
export function toolOperation(
  tool: { readonly name: string; readonly capabilityId: string; readonly verb: string },
  input: unknown,
): ToolOperation | null {
  const fields = toolFields[tool.name]?.(input) ?? null;
  if (!fields || !["view", "propose", "execute", "delegate"].includes(tool.verb)) return null;
  return Object.freeze({
    capabilityId: tool.capabilityId,
    verb: tool.verb as ToolOperation["verb"],
    fields: Object.freeze([...fields]),
  });
}

/** The ids a tool's input names must be the run's own (ADR-0027 item 2: ids in scope). */
export function idsInScope(tool: string, input: unknown, run: AgentRunState): boolean {
  const v = input as Record<string, unknown>;
  if (tool === "work.read")
    return v.id === null || v.id === run.taskId || v.id === run.childTaskId;
  // Product ids are checked by the store read itself (only the run's store is reachable);
  // every other tool names no id, or names only codes and text.
  return true;
}

/** The authority port of the tool-call step: one decision per call, in this step. */
export interface ToolAuthority {
  decide(
    step: LeaseStep,
    run: AgentRunState,
    tool: { readonly name: string; readonly capabilityId: string; readonly verb: string },
    input: unknown,
  ): Promise<"allowed" | Extract<ToolRefusal, "authority_denied" | "stopped">>;
}
/**
 * The routed run's authority (the only kind this migration admits): decideDelegation for
 * the envelope the run names, executed by its installation, on its store.
 */
export function createDelegationAuthority(options: {
  readonly environment: "development" | "staging" | "production";
  readonly now: () => number;
}): ToolAuthority {
  const authority: ToolAuthority = {
    async decide(step, run, tool, input) {
      if (run.kind !== "routed") return "authority_denied" as const;
      const op = toolOperation(tool, input);
      if (!op) return "authority_denied" as const;
      const lease = step.lease;
      if (
        lease.storeId !== run.storeId ||
        lease.connectionId !== run.connectionId ||
        lease.installationId !== run.installationId
      )
        return "authority_denied" as const;
      const rows = await step.run.billingFacts();
      const reader = createLeaseDelegationReader({
        facts: step.delegationFacts,
        billing: {
          read: (scope) =>
            createBillingFactsReader(async (name) => rows[name] ?? Object.freeze([])).read(scope),
        },
        environment: options.environment,
        clock: () => new Date(options.now()),
      });
      const service = createAgentAuthorityService(reader, () => new Date(options.now()));
      try {
        const r = await service.decideDelegation(
          JSON.stringify({
            envelopeId: run.envelopeId,
            executorInstallationId: run.installationId,
            operation: {
              capabilityId: op.capabilityId as CapabilityId,
              verb: op.verb,
              resource: storeResource(
                lease.organizationId,
                lease.workspaceId,
                run.storeId,
                run.connectionId,
              ),
              accountId: null,
              fields: [...op.fields],
            },
          }),
        );
        if (r.decision.allowed) return "allowed" as const;
        // The store's association or a stop (providerAllowed) is a stop; anything else denies.
        return r.decision.reason === "provider_denied"
          ? ("stopped" as const)
          : ("authority_denied" as const);
      } catch {
        // Missing or malformed facts deny (AGENT_POLICY_AUTHORITY_UNAVAILABLE).
        return "authority_denied" as const;
      }
    },
  };
  return Object.freeze(authority);
}
