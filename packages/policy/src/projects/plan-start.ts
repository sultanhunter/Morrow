import { createHash } from "node:crypto";
import type {
  CapabilityId,
  Current_ContextTaint,
  Current_Grant,
  Current_HumanActorRef,
  Current_PlanDraft,
  Current_PlanStartDocument,
  Current_PlanStartRecords,
  Current_PlanStepRun,
  Current_PlanTarget,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { areaStartRecords, quickTasksStartRecords, type AreaId } from "./area-templates";
import { planDraftsRecord, planDraftValid } from "./plan-draft";

// The plan start (ADR-0034 items 5 and 6). On Start the server builds PlanStartDocument@1
// for the person who asked (or, for a card code builds, the person who opened it), on a
// standalone-workspace session. It binds the draft digest, the target and its revision,
// the records code computes, the estimate shown and a digest of the person's grant summary
// (never the authority). It lasts 5 minutes and is consumed once. One transaction then
// consumes it, runs the human kernel for every piece under the person's live grants,
// creates the records as that person's own commands and writes one audit record; any
// refusal rolls everything back. It never admits a run: each step's run is admitted after
// commit, on its own, and a refusal leaves that step Not started with its own button.

export const planStartWindowMs = 5 * 60 * 1000;
export type StartSurface = "standalone" | "embedded" | "email";
export type StartRefusal =
  | "unavailable"
  | "plan_drafts_off"
  | "actor_ineligible"
  | "input_invalid"
  | "stale"
  | "denied"
  | "stopped";

/** What a Start is for: a Morrow card, or a card code builds with no model. */
export type StartCard =
  | {
      readonly kind: "draft";
      readonly messageId: string;
      readonly revision: number;
      readonly digest: string;
      readonly draft: Current_PlanDraft;
      /** The person whose request the card answers (the Ask's owner, or @Morrow's author). */
      readonly askerPrincipalId: string;
      readonly contextTaint: Current_ContextTaint;
      /** For a plan change or a dated target already set: the project's current date. */
      readonly currentDueAt: string | null;
      /**
       * For a plan change: whether the project's goal record is the actor's own. Ownership
       * selects the verb of workspace.goal.revise (own -> execute, other -> administer), as
       * the revise route does; a goal record's owner never changes.
       */
      readonly targetOwner?: "own" | "other" | null;
    }
  | { readonly kind: "area"; readonly areaTemplateId: AreaId }
  | { readonly kind: "quick_tasks" };

/**
 * The gate before any document, lock or record (ADR-0034 item 10): 503 while the start
 * routes are held (until lab:plan-start passes); while the switch is off, only code-built
 * cards (areas, Quick tasks and Finish's own document, which never waits on the loop).
 */
export function startRouteGate(
  card: Pick<StartCard, "kind">,
  record: {
    readonly switch: "on" | "off";
    readonly start_routes: "held" | "ready";
  } = planDraftsRecord,
): "ok" | "unavailable" | "plan_drafts_off" {
  if (record.start_routes !== "ready") return "unavailable";
  if (card.kind === "draft" && record.switch !== "on") return "plan_drafts_off";
  return "ok";
}

export interface StartActor {
  readonly kind: "human" | "agent" | "service";
  readonly principalId: string;
  readonly membershipId: string | null;
}
/**
 * Only the asker gets a document (owner question 2); for a code-built card, the person who
 * opened it, which is the actor. Anyone else, any agent and any embedded or email session
 * gets `actor_ineligible`.
 */
export function startEligible(
  actor: StartActor,
  surface: StartSurface,
  card: StartCard,
): "ok" | "actor_ineligible" {
  if (actor.kind !== "human" || actor.membershipId === null) return "actor_ineligible";
  if (surface !== "standalone") return "actor_ineligible";
  if (card.kind === "draft" && card.askerPrincipalId !== actor.principalId)
    return "actor_ineligible";
  return "ok";
}

/** The records a card creates, computed by code from the card alone. */
export function startRecords(card: StartCard): Current_PlanStartRecords | null {
  if (card.kind === "area") return areaStartRecords(card.areaTemplateId);
  if (card.kind === "quick_tasks") return quickTasksStartRecords();
  const d = card.draft;
  if (!planDraftValid(d)) return null;
  const tasks = d.steps
    .filter((s) => s.repeat === null)
    .map((s) => ({ stepKey: s.key, objective: s.title, assignee: s.assignee }));
  const repeating = d.steps
    .filter((s) => s.repeat !== null)
    .map((s) => ({
      stepKey: s.key,
      title: s.title,
      cadence: s.repeat!.cadence,
      goalKey: s.repeat!.goalKey,
      agent: s.assignee.kind === "agent",
    }));
  const criteria = d.goals.map((g) => ({
    description: g.description,
    verificationCapabilityId: null,
    evidenceRequired: false,
    key: g.key,
    measure: g.measure,
  }));
  if (d.kind === "project" && d.target.kind === "new_project")
    return {
      goal: {
        objective: d.doneWhen,
        dueAt: d.target.dueAt,
        areaTemplateId: null,
        successCriteria: criteria,
      },
      project: { title: d.title, pin: true },
      tasks,
      repeating,
    };
  if (d.kind === "plan_change")
    return {
      goal:
        criteria.length === 0
          ? null
          : {
              objective: d.doneWhen,
              dueAt: card.currentDueAt,
              areaTemplateId: null,
              successCriteria: criteria,
            },
      project: null,
      tasks,
      repeating,
    };
  return { goal: null, project: null, tasks, repeating };
}

/** One piece the person must be able to create by hand, decided by the human kernel. */
export interface PieceCheck {
  readonly piece: string;
  readonly capabilityId: CapabilityId;
  readonly verb: "execute" | "administer";
  readonly fields: readonly string[];
}
const goalCreateFields = ["objective", "storeIds", "successCriteria"] as const;
/**
 * Every grant the start needs, one per piece: the goal record, the project and its pin
 * (both human_only), each task and its assignment to someone else, each repeating task
 * (a routine configured disabled), and a plan change's revision. The person who creates
 * the records owns them, so every verb is `execute`, except a plan change's revision of
 * another member's goal record, which needs `administer` (the revise route's rule).
 */
export function startChecks(
  card: StartCard,
  records: Current_PlanStartRecords,
  actorPrincipalId: string,
): readonly PieceCheck[] {
  const checks: PieceCheck[] = [];
  const add = (
    piece: string,
    capabilityId: CapabilityId,
    fields: readonly string[],
    verb: PieceCheck["verb"] = "execute",
  ) => checks.push({ piece, capabilityId, verb, fields });
  const changing = card.kind === "draft" && card.draft.kind === "plan_change";
  if (records.goal !== null) {
    if (changing)
      add(
        "goal",
        "workspace.goal.revise",
        ["goalId", "expectedRevision", "objective", "dueAt", "successCriteria"],
        card.kind === "draft" && card.targetOwner === "own" ? "execute" : "administer",
      );
    else add("goal", "workspace.goal.create", goalCreateFields);
  }
  if (records.project !== null) {
    add("project", "workspace.project.create", ["goalId", "title", "tabs"]);
    if (records.project.pin) add("pin", "workspace.project.pin", ["pinned", "beforeProjectId"]);
  }
  for (const t of records.tasks) {
    add(`task:${t.stepKey}`, "workspace.task.create", ["goalId", "objective", "allowedResources"]);
    if (t.assignee.kind === "person" && t.assignee.principalId !== actorPrincipalId)
      add(`assign:${t.stepKey}`, "workspace.task.assign", [
        "taskId",
        "assigneeId",
        "expectedRevision",
      ]);
  }
  for (const r of records.repeating)
    add(`repeating:${r.stepKey}`, "workspace.routine.configure", [
      "installationId",
      "schedule",
      "mandate",
      "goalId",
      "goalKey",
    ]);
  return Object.freeze(checks);
}

const canonical = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? "[" + v.map(canonical).join(",") + "]"
      : "{" +
        Object.keys(v as object)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k]))
          .join(",") +
        "}";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The grant summary a document binds: for each current grant on a capability the start
 * checks, its id, capability, sorted verbs, fields and validity. Any grant issued, revoked,
 * narrowed or expiring changes the digest, and the start answers `stale`. It is a digest,
 * never the authority: the start decides again under live grants.
 */
export function grantSummaryDigest(
  grants: readonly Current_Grant[],
  capabilities: readonly CapabilityId[],
  nowMs: number,
): string {
  const wanted = new Set<string>(capabilities);
  const rows = grants
    .filter(
      (g) =>
        wanted.has(g.capabilityId) &&
        g.revokedAt === null &&
        Date.parse(g.validFrom) <= nowMs &&
        (g.expiresAt === null || Date.parse(g.expiresAt) > nowMs),
    )
    .map((g) => ({
      id: g.id,
      capabilityId: g.capabilityId,
      verbs: [...g.verbs].sort(),
      fields: [...g.scope.fields].sort(),
      expiresAt: g.expiresAt,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256(canonical(["morrow.plan_start.grant_summary", 1, rows]));
}

export interface DocumentInput {
  readonly id: string;
  readonly card: StartCard;
  readonly actor: Current_HumanActorRef;
  readonly target: Current_PlanTarget;
  readonly records: Current_PlanStartRecords;
  readonly estimate: { readonly creditsLow: number; readonly creditsHigh: number };
  readonly grantSummaryDigest: string;
  readonly nowMs: number;
}
export interface BuiltDocument {
  readonly document: Current_PlanStartDocument;
  readonly canonical: string;
  readonly digest: string;
}
/** PlanStartDocument@1, its canonical text and digest (what the definer stores). */
export function buildPlanStartDocument(input: DocumentInput): BuiltDocument {
  const at = input.nowMs - (input.nowMs % 1000);
  const card = input.card;
  const document: Current_PlanStartDocument = {
    schemaVersion: 1,
    id: input.id,
    purpose: card.kind === "draft" ? "plan_card" : card.kind,
    organizationId: input.actor.organizationId,
    workspaceId: input.actor.workspaceId,
    actor: input.actor,
    draft:
      card.kind === "draft"
        ? { messageId: card.messageId, revision: card.revision, digest: card.digest }
        : null,
    target: input.target,
    records: input.records,
    estimate: input.estimate,
    grantSummaryDigest: input.grantSummaryDigest,
    contextTaint: card.kind === "draft" ? card.contextTaint : "none",
    createdAt: new Date(at).toISOString(),
    expiresAt: new Date(at + planStartWindowMs).toISOString(),
  };
  if (
    !validateCurrentDefinition("PlanStartDocument", document) ||
    input.estimate.creditsLow > input.estimate.creditsHigh
  )
    throw new TypeError("PLAN_START_DOCUMENT_INVALID");
  const text = canonical(document);
  return Object.freeze({ document, canonical: text, digest: sha256(text) });
}
/** The target a card names, as the document binds it. */
export function startTarget(card: StartCard): Current_PlanTarget {
  if (card.kind === "area") return { kind: "area", areaTemplateId: card.areaTemplateId };
  if (card.kind === "quick_tasks") return { kind: "quick_tasks" };
  return card.draft.target;
}
/** A nonce's stored digest: the definer keeps only this. */
export const nonceDigest = (nonce: string) => sha256(nonce);

export interface StoredDocument {
  readonly canonical: string;
  readonly digest: string;
  readonly actorPrincipalId: string;
  readonly actorMembershipId: string;
  readonly sessionDigest: string;
  readonly nonceDigest: string;
  readonly expiresAtMs: number;
  readonly consumed: boolean;
}
export interface StartAttempt {
  readonly actor: StartActor;
  readonly surface: StartSurface;
  readonly sessionDigest: string;
  readonly nonce: string;
  readonly nowMs: number;
  /** The card's current draft revision and digest (a later edit makes the document stale). */
  readonly currentDraft: { readonly revision: number; readonly digest: string } | null;
  /** The target's current goal revision (a plan change), or null. */
  readonly currentTargetRevision: number | null;
  /** The grant summary digest recomputed from live grants at this moment. */
  readonly liveGrantSummaryDigest: string;
  /** Every assignee is still an eligible member or an active installation. */
  readonly assigneesCurrent: boolean;
}
/**
 * The checks of (a), before the kernel's (b): the document is the actor's own, on its
 * session, unexpired, unconsumed, with its nonce, and nothing it binds has changed. An
 * unknown, expired or reused digest, or any change, is `stale`; an agent, another member
 * or another surface is `actor_ineligible`. The definer repeats each under lock.
 */
export function checkStartAttempt(
  stored: StoredDocument | null,
  attempt: StartAttempt,
): "ok" | "stale" | "actor_ineligible" {
  if (attempt.actor.kind !== "human" || attempt.surface !== "standalone") return "actor_ineligible";
  if (stored === null) return "stale";
  if (
    stored.actorPrincipalId !== attempt.actor.principalId ||
    stored.actorMembershipId !== attempt.actor.membershipId
  )
    return "actor_ineligible";
  if (stored.sessionDigest !== attempt.sessionDigest) return "actor_ineligible";
  if (stored.consumed || attempt.nowMs >= stored.expiresAtMs) return "stale";
  if (stored.nonceDigest !== nonceDigest(attempt.nonce)) return "stale";
  if (sha256(stored.canonical) !== stored.digest) return "stale";
  const document = JSON.parse(stored.canonical) as Current_PlanStartDocument;
  if (document.draft !== null) {
    if (
      attempt.currentDraft === null ||
      attempt.currentDraft.revision !== document.draft.revision ||
      attempt.currentDraft.digest !== document.draft.digest
    )
      return "stale";
  }
  if (document.target.kind === "existing_project") {
    if (attempt.currentTargetRevision !== document.target.goalRevision) return "stale";
  }
  if (!attempt.assigneesCurrent) return "stale";
  if (attempt.liveGrantSummaryDigest !== document.grantSummaryDigest) return "stale";
  return "ok";
}

/**
 * What the same tap starts after commit (ADR-0034 item 6). A specialist step: one
 * Coordinator run with the Owner as requester, only when the Owner taps; a teammate's tap
 * offers "Ask [Owner]". A ready agent step (no unmet dependency) runs as the person's own
 * run; a later step waits for its own tap. While the agent loop is off, every step is
 * `not_started` with `agent_loop_off`. Person and code steps start no run.
 */
export interface StepRunFacts {
  readonly actorIsOwner: boolean;
  readonly agentLoop: "on" | "off";
}
export interface StepRunIntent {
  readonly stepKey: string;
  readonly kind: "specialist_draft" | "agent_step";
}
export function planStepRuns(
  card: StartCard,
  facts: StepRunFacts,
): { readonly admit: readonly StepRunIntent[]; readonly runs: readonly Current_PlanStepRun[] } {
  if (card.kind !== "draft") return { admit: [], runs: [] };
  const admit: StepRunIntent[] = [];
  const runs: Current_PlanStepRun[] = [];
  for (const step of card.draft.steps) {
    if (step.repeat !== null) continue;
    const kind = step.assignee.kind;
    if (kind !== "specialist" && kind !== "agent") continue;
    const notStarted = (reason: string) =>
      runs.push({ stepKey: step.key, status: "not_started", reason });
    if (facts.agentLoop !== "on") notStarted("agent_loop_off");
    else if (kind === "specialist" && !facts.actorIsOwner) notStarted("ask_owner");
    else if (kind === "agent" && step.dependsOn.length > 0) notStarted("waits_for_step");
    else
      admit.push({
        stepKey: step.key,
        kind: kind === "specialist" ? "specialist_draft" : "agent_step",
      });
  }
  return { admit: Object.freeze(admit), runs: Object.freeze(runs) };
}

/** The human kernel's decision on one piece (createHumanPolicyService under live grants). */
export interface PieceDecider {
  decide(check: PieceCheck): Promise<{ readonly allowed: boolean; readonly reason: string }>;
}
/**
 * (b): every piece under the person's live grants, in order; the first refusal refuses the
 * whole start (`denied`, nothing created). A stopped workspace or assignee is the definer's
 * `stopped`, checked under lock.
 */
export async function decideStartPieces(
  checks: readonly PieceCheck[],
  decider: PieceDecider,
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusal: "denied";
      readonly piece: string;
      readonly reason: string;
    }
> {
  for (const check of checks) {
    const decision = await decider.decide(check);
    if (!decision.allowed)
      return { ok: false, refusal: "denied", piece: check.piece, reason: decision.reason };
  }
  return { ok: true };
}
