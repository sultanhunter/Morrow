import {
  runFixedSqlTransaction,
  type FixedSqlAttempt,
  type FixedSqlOutcome,
  type FixedSqlPool,
  type FixedSqlQuery,
} from "../../../identity/src/fixed-sql-transaction.js";

// The agent loop's SQL (build order PR 11; migration agent-runs), sent inside one entered run
// lease (runLeaseStep: step.loop) or, for the two id lookups, in a runtime transaction of
// their own. Source-fixed statements, values only as bind parameters (an absent optional
// value is the empty string, which the statement turns into NULL), every selected column
// text. Each decoder accepts only its definer's closed shape; anything else is
// RUNTIME_AGENT_RUN_HELD, so the step fails and the Workflow retries it. Content (the
// request, the conversation, tool results) passes through here in memory only; the
// Workflow's step results carry ids and codes (ADR-0027 item 7).

export const agentRunSql = Object.freeze({
  start: "SELECT outcome,status FROM morrow_work.agent_run_start()",
  state:
    "SELECT outcome,run_id,status,kind,task_id,child_task_id,envelope_id,installation_id,agent_principal_id,store_id,connection_id,requester_principal_id,requester_membership_id,release_id,system_text_digest,tools,catalogue_version,model_key,effort_key,turn_limit,tool_calls_per_turn,tool_calls_per_run,questions_limit,max_input_tokens,max_output_tokens,wall_time_ms,hold_usd,worst_case_turn_usd,booked_usd,overflow_usd,turns_taken,tool_calls_taken,questions_asked,active_ms,lease_expires_at_ms,database_now_ms,tainted,prefix_digest FROM morrow_work.agent_run_state()",
  objective: "SELECT outcome,objective FROM morrow_work.agent_run_objective()",
  conversation:
    "SELECT turn,attempt,input,input_digest,output,outcome,tool_results,prefix_digest_after FROM morrow_work.agent_run_conversation()",
  answers: "SELECT tool_use_id,answer FROM morrow_work.agent_run_answers()",
  turnOpen: "SELECT outcome,reason FROM morrow_work.agent_turn_open($1,$2,$3,$4,$5,$6)",
  turnSettle:
    "SELECT outcome,turn_outcome,open_call,last_sequence FROM morrow_work.agent_turn_settle($1,$2)",
  toolBegin:
    "SELECT outcome,refusal,capability_id,verb,replay_class,recorded_outcome,recorded_refusal,record_kind,record_id,result_digest FROM morrow_work.agent_tool_call_begin($1,$2,$3,$4,$5)",
  toolFinish:
    "SELECT outcome FROM morrow_work.agent_tool_call_finish($1,$2,NULLIF($3,''),$4,$5,NULLIF($6,''),NULLIF($7,''),$8)",
  questionAsk: "SELECT outcome,question_id FROM morrow_work.agent_question_ask($1,$2,$3)",
  wait: "SELECT outcome,question_id FROM morrow_work.agent_run_wait()",
  finish: "SELECT outcome,status FROM morrow_work.agent_run_finish($1)",
  pendingStarts:
    "SELECT organization_id,workspace_id,run_id,lease_id,generation,resume FROM morrow_work.agent_run_pending_starts()",
  resumeLease: "SELECT lease_id,generation FROM morrow_work.agent_run_resume_lease($1,$2,$3)",
} as const);

/** How an agent run ended (AgentRunEndReason): code derives it, never model text. */
export type AgentRunEndReason =
  | "completed"
  | "turn_limit"
  | "tool_call_limit"
  | "cost_budget"
  | "wall_time"
  | "deadline"
  | "question_unanswered"
  | "invalid_output"
  | "refusal"
  | "spend_limit"
  | "provider_error"
  | "prefix_mismatch"
  | "stopped"
  | "lease_ended"
  | "mandate_ended"
  | "task_closed"
  | "switch_off";
export const agentRunEndReasons: readonly AgentRunEndReason[] = Object.freeze([
  "completed",
  "turn_limit",
  "tool_call_limit",
  "cost_budget",
  "wall_time",
  "deadline",
  "question_unanswered",
  "invalid_output",
  "refusal",
  "spend_limit",
  "provider_error",
  "prefix_mismatch",
  "stopped",
  "lease_ended",
  "mandate_ended",
  "task_closed",
  "switch_off",
]);
export type ToolCallOutcome =
  | "ok"
  | "refused"
  | "invalid_input"
  | "tool_outcome_unknown"
  | "computer_unavailable";
export const toolCallOutcomes: readonly ToolCallOutcome[] = Object.freeze([
  "ok",
  "refused",
  "invalid_input",
  "tool_outcome_unknown",
  "computer_unavailable",
]);
export type ToolRefusal =
  | "not_offered"
  | "lease_ended"
  | "run_closed"
  | "deadline_passed"
  | "task_closed"
  | "release_revoked"
  | "switch_off"
  | "stopped"
  | "input_invalid"
  | "id_out_of_scope"
  | "authority_denied"
  | "budget_exhausted"
  | "tool_call_limit"
  | "question_limit"
  | "route_used"
  | "report_in_turn"
  | "result_too_large"
  | "sender_inactive"
  | "sender_not_usable";
export const toolRefusals: readonly ToolRefusal[] = Object.freeze([
  "not_offered",
  "lease_ended",
  "run_closed",
  "deadline_passed",
  "task_closed",
  "release_revoked",
  "switch_off",
  "stopped",
  "input_invalid",
  "id_out_of_scope",
  "authority_denied",
  "budget_exhausted",
  "tool_call_limit",
  "question_limit",
  "route_used",
  "report_in_turn",
  "result_too_large",
  "sender_inactive",
  "sender_not_usable",
]);
export type RecordKind =
  | "message"
  | "question"
  | "task"
  | "suggestion"
  | "artifact"
  | "proposal"
  | "specialist_spec";
const recordKinds: readonly string[] = [
  "message",
  "question",
  "task",
  "suggestion",
  "artifact",
  "proposal",
  "specialist_spec",
];
export type RecordedTurnOutcome =
  | "end_turn"
  | "tool_use"
  | "incomplete"
  | "refusal"
  | "invalid_output"
  | "spend_limit"
  | "provider_error"
  | "uncertain"
  | "not_sent"
  | "input_over_cap"
  | "prefix_mismatch";
const turnOutcomes: readonly string[] = [
  "end_turn",
  "tool_use",
  "incomplete",
  "refusal",
  "invalid_output",
  "spend_limit",
  "provider_error",
  "uncertain",
  "not_sent",
  "input_over_cap",
  "prefix_mismatch",
];

/** The entered lease's run as every step checks it: ids, codes, caps, counters, amounts. */
export interface AgentRunState {
  readonly runId: string;
  readonly status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  readonly kind: "routed";
  readonly taskId: string;
  readonly childTaskId: string;
  readonly envelopeId: string;
  readonly installationId: string;
  readonly agentPrincipalId: string;
  readonly storeId: string;
  readonly connectionId: string;
  readonly requesterPrincipalId: string;
  readonly requesterMembershipId: string;
  readonly releaseId: string;
  readonly systemTextDigest: string;
  readonly tools: readonly string[];
  readonly catalogueVersion: number;
  readonly model: string;
  readonly effort: string;
  readonly turnLimit: number;
  readonly toolCallsPerTurn: number;
  readonly toolCallsPerRun: number;
  readonly questionsLimit: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly wallTimeMs: number;
  /** numeric(20,8) USD text. */
  readonly holdUsd: string;
  readonly worstCaseTurnUsd: string;
  readonly bookedUsd: string;
  readonly overflowUsd: string;
  readonly turnsTaken: number;
  readonly toolCallsTaken: number;
  readonly questionsAsked: number;
  /** Wall time used so far, waits excluded, the running segment included. */
  readonly activeMs: number;
  readonly leaseExpiresAtMs: number;
  readonly databaseNowMs: number;
  readonly tainted: boolean;
  readonly prefixDigest: string | null;
}
/** One stored turn attempt (content: in memory, inside one step only). */
export interface ConversationRow {
  readonly turn: number;
  readonly attempt: number;
  readonly input: unknown;
  readonly inputDigest: string;
  readonly output: unknown;
  readonly outcome: RecordedTurnOutcome | null;
  readonly toolResults: readonly unknown[];
  readonly prefixDigestAfter: string | null;
}
/** One answered question (content: in memory, inside one step only). */
export interface QuestionAnswer {
  readonly toolUseId: string;
  readonly answer: string;
}
export type TurnOpen =
  | { readonly outcome: "opened" | "opened_before" }
  | { readonly outcome: "stop"; readonly reason: "turn_limit" | "cost_budget" | "wall_time" }
  | { readonly outcome: "conflict" | "run_inactive" | "invalid" | "denied" };
export type TurnSettle =
  | {
      readonly outcome: "found";
      readonly turnOutcome: RecordedTurnOutcome | null;
      readonly openCall: "none" | "live";
      readonly lastSequence: number;
    }
  | { readonly outcome: "run_inactive" | "invalid" | "denied" };
export type ToolBegin =
  | {
      readonly outcome: "begun" | "resumed";
      readonly capabilityId: string;
      readonly verb: string;
      readonly replayClass: "read" | "internal_write" | "computer";
    }
  | {
      readonly outcome: "refuse";
      readonly refusal: "not_offered" | "tool_call_limit";
      readonly capabilityId: string;
      readonly verb: string;
      readonly replayClass: "read" | "internal_write" | "computer";
    }
  | {
      readonly outcome: "replay";
      readonly capabilityId: string;
      readonly verb: string;
      readonly replayClass: "read" | "internal_write" | "computer";
      readonly recordedOutcome: ToolCallOutcome;
      readonly recordedRefusal: ToolRefusal | null;
      readonly record: { readonly kind: RecordKind; readonly id: string } | null;
      readonly resultDigest: string;
    }
  | { readonly outcome: "run_inactive" | "invalid" | "denied" };
export interface ToolFinish {
  readonly toolUseId: string;
  readonly outcome: ToolCallOutcome;
  readonly refusal: ToolRefusal | null;
  readonly result: string;
  readonly resultDigest: string;
  readonly record: { readonly kind: RecordKind; readonly id: string } | null;
  readonly untrusted: boolean;
}
export interface AgentRunSteps {
  start(): Promise<
    | {
        readonly outcome: "started" | "resumed" | "running" | "waiting" | "ended";
        readonly status: string;
      }
    | { readonly outcome: "denied" }
  >;
  state(): Promise<AgentRunState | "denied">;
  /** The person's request (turn 1's text): in memory, within the step only. */
  objective(): Promise<string | "denied">;
  conversation(): Promise<readonly ConversationRow[]>;
  /** The requester's answers to the run's questions, by the inbox.ask call's tool_use id. */
  answers(): Promise<readonly QuestionAnswer[]>;
  turnOpen(input: {
    readonly turn: number;
    readonly attempt: number;
    readonly inputCanonical: string;
    readonly inputDigest: string;
    readonly untrusted: boolean;
    readonly readTagsCanonical: string;
  }): Promise<TurnOpen>;
  turnSettle(turn: number, attempt: number): Promise<TurnSettle>;
  toolBegin(input: {
    readonly turn: number;
    readonly ordinal: number;
    readonly toolUseId: string;
    readonly tool: string;
    readonly inputDigest: string;
  }): Promise<ToolBegin>;
  toolFinish(
    input: ToolFinish,
  ): Promise<"finished" | "replay" | "conflict" | "run_inactive" | "invalid" | "denied">;
  questionAsk(
    toolUseId: string,
    question: string,
    choicesCanonical: string,
  ): Promise<
    | { readonly outcome: "asked" | "replay"; readonly questionId: string }
    | { readonly outcome: "question_limit" | "run_inactive" | "invalid" | "denied" }
  >;
  wait(): Promise<
    | { readonly outcome: "waiting"; readonly questionId: string }
    | { readonly outcome: "call_open" | "run_inactive" | "invalid" | "denied" }
  >;
  finish(
    reason: AgentRunEndReason,
  ): Promise<
    | { readonly outcome: "ended"; readonly status: "succeeded" | "failed" | "cancelled" }
    | { readonly outcome: "call_open" | "invalid" | "denied" }
  >;
}

const held = () => Error("RUNTIME_AGENT_RUN_HELD");
const recordId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const usd = /^(0|[1-9][0-9]{0,11})\.[0-9]{8}$/;
const selectionKey = /^[a-z][a-z0-9_]{0,39}$/;
const toolName = /^[a-z]+(\.[a-z]+)+$/;
const toolUseId = /^[A-Za-z0-9_-]{1,64}$/;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
function one(rows: readonly Record<string, unknown>[], names: readonly string[]) {
  if (!Array.isArray(rows) || rows.length !== 1) throw held();
  return shape(rows[0], names);
}
function shape(row: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join(",") !== [...names].sort().join(",")
  )
    throw held();
  return row as Record<string, unknown>;
}
const integer = (value: unknown, min: number, max: number) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value)) throw held();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw held();
  return n;
};
const json = (value: unknown): unknown => {
  if (typeof value !== "string") throw held();
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw held();
  }
};
const allNull = (r: Record<string, unknown>, except: readonly string[]) =>
  Object.entries(r).every(([k, v]) => except.includes(k) || v === null);
const replayClasses: readonly string[] = ["read", "internal_write", "computer"];

/** The run steps over one entered lease's query (runLeaseStep passes its own). */
export function createAgentRunSteps(query: FixedSqlQuery): AgentRunSteps {
  const steps: AgentRunSteps = {
    async start() {
      const r = one(await query(agentRunSql.start), ["outcome", "status"]);
      if (r.outcome === "denied") {
        if (r.status !== null) throw held();
        return Object.freeze({ outcome: "denied" as const });
      }
      if (
        !["started", "resumed", "running", "waiting", "ended"].includes(r.outcome as string) ||
        typeof r.status !== "string" ||
        !["running", "waiting", "succeeded", "failed", "cancelled"].includes(r.status)
      )
        throw held();
      return Object.freeze({
        outcome: r.outcome as "started" | "resumed" | "running" | "waiting" | "ended",
        status: r.status,
      });
    },
    async state() {
      const names = [
        "outcome",
        "run_id",
        "status",
        "kind",
        "task_id",
        "child_task_id",
        "envelope_id",
        "installation_id",
        "agent_principal_id",
        "store_id",
        "connection_id",
        "requester_principal_id",
        "requester_membership_id",
        "release_id",
        "system_text_digest",
        "tools",
        "catalogue_version",
        "model_key",
        "effort_key",
        "turn_limit",
        "tool_calls_per_turn",
        "tool_calls_per_run",
        "questions_limit",
        "max_input_tokens",
        "max_output_tokens",
        "wall_time_ms",
        "hold_usd",
        "worst_case_turn_usd",
        "booked_usd",
        "overflow_usd",
        "turns_taken",
        "tool_calls_taken",
        "questions_asked",
        "active_ms",
        "lease_expires_at_ms",
        "database_now_ms",
        "tainted",
        "prefix_digest",
      ];
      const r = one(await query(agentRunSql.state), names);
      if (r.outcome === "denied") {
        if (!allNull(r, ["outcome"])) throw held();
        return "denied" as const;
      }
      const tools = json(r.tools);
      if (
        r.outcome !== "found" ||
        !exact(uuid, r.run_id) ||
        !["queued", "running", "waiting", "succeeded", "failed", "cancelled"].includes(
          r.status as string,
        ) ||
        r.kind !== "routed" ||
        ![
          r.task_id,
          r.child_task_id,
          r.envelope_id,
          r.installation_id,
          r.agent_principal_id,
          r.store_id,
          r.connection_id,
          r.requester_principal_id,
          r.requester_membership_id,
        ].every((v) => exact(recordId, v)) ||
        typeof r.release_id !== "string" ||
        !/^[a-z][a-z0-9_.]{2,63}$/.test(r.release_id) ||
        !exact(digest, r.system_text_digest) ||
        !Array.isArray(tools) ||
        tools.length < 1 ||
        tools.length > 32 ||
        !tools.every((t) => exact(toolName, t)) ||
        new Set(tools).size !== tools.length ||
        !exact(selectionKey, r.model_key) ||
        !exact(selectionKey, r.effort_key) ||
        ![r.hold_usd, r.worst_case_turn_usd, r.booked_usd, r.overflow_usd].every((v) =>
          exact(usd, v),
        ) ||
        (r.tainted !== "true" && r.tainted !== "false") ||
        (r.prefix_digest !== null && !exact(digest, r.prefix_digest))
      )
        throw held();
      return Object.freeze({
        runId: r.run_id,
        status: r.status as AgentRunState["status"],
        kind: "routed" as const,
        taskId: r.task_id as string,
        childTaskId: r.child_task_id as string,
        envelopeId: r.envelope_id as string,
        installationId: r.installation_id as string,
        agentPrincipalId: r.agent_principal_id as string,
        storeId: r.store_id as string,
        connectionId: r.connection_id as string,
        requesterPrincipalId: r.requester_principal_id as string,
        requesterMembershipId: r.requester_membership_id as string,
        releaseId: r.release_id,
        systemTextDigest: r.system_text_digest,
        tools: Object.freeze([...(tools as string[])]),
        catalogueVersion: integer(r.catalogue_version, 1, 999),
        model: r.model_key,
        effort: r.effort_key,
        turnLimit: integer(r.turn_limit, 1, 16),
        toolCallsPerTurn: integer(r.tool_calls_per_turn, 0, 4),
        toolCallsPerRun: integer(r.tool_calls_per_run, 0, 40),
        questionsLimit: integer(r.questions_limit, 0, 2),
        maxInputTokens: integer(r.max_input_tokens, 1, 64000),
        maxOutputTokens: integer(r.max_output_tokens, 1, 16000),
        wallTimeMs: integer(r.wall_time_ms, 60000, 1800000),
        holdUsd: r.hold_usd as string,
        worstCaseTurnUsd: r.worst_case_turn_usd as string,
        bookedUsd: r.booked_usd as string,
        overflowUsd: r.overflow_usd as string,
        turnsTaken: integer(r.turns_taken, 0, 16),
        toolCallsTaken: integer(r.tool_calls_taken, 0, 40),
        questionsAsked: integer(r.questions_asked, 0, 2),
        activeMs: integer(r.active_ms, 0, Number.MAX_SAFE_INTEGER),
        leaseExpiresAtMs: integer(r.lease_expires_at_ms, 1, Number.MAX_SAFE_INTEGER),
        databaseNowMs: integer(r.database_now_ms, 1, Number.MAX_SAFE_INTEGER),
        tainted: r.tainted === "true",
        prefixDigest: r.prefix_digest as string | null,
      });
    },
    async objective() {
      const r = one(await query(agentRunSql.objective), ["outcome", "objective"]);
      if (r.outcome === "denied") {
        if (r.objective !== null) throw held();
        return "denied" as const;
      }
      if (
        r.outcome !== "found" ||
        typeof r.objective !== "string" ||
        r.objective.length < 1 ||
        [...r.objective].length > 8192
      )
        throw held();
      return r.objective;
    },
    async conversation() {
      const rows = await query(agentRunSql.conversation);
      if (!Array.isArray(rows) || rows.length > 32) throw held();
      return Object.freeze(
        rows.map((row) => {
          const r = shape(row, [
            "turn",
            "attempt",
            "input",
            "input_digest",
            "output",
            "outcome",
            "tool_results",
            "prefix_digest_after",
          ]);
          const results = json(r.tool_results);
          if (
            !exact(digest, r.input_digest) ||
            (r.outcome !== null && !turnOutcomes.includes(r.outcome as string)) ||
            !Array.isArray(results) ||
            results.length > 4 ||
            (r.prefix_digest_after !== null && !exact(digest, r.prefix_digest_after)) ||
            (r.output !== null && typeof r.output !== "string")
          )
            throw held();
          return Object.freeze({
            turn: integer(r.turn, 1, 16),
            attempt: integer(r.attempt, 1, 2),
            input: json(r.input),
            inputDigest: r.input_digest,
            output: r.output === null ? null : json(r.output),
            outcome: r.outcome as RecordedTurnOutcome | null,
            toolResults: Object.freeze(results),
            prefixDigestAfter: r.prefix_digest_after as string | null,
          });
        }),
      );
    },
    async answers() {
      const rows = await query(agentRunSql.answers);
      if (!Array.isArray(rows) || rows.length > 2) throw held();
      const seen = new Set<string>();
      return Object.freeze(
        rows.map((row) => {
          const r = shape(row, ["tool_use_id", "answer"]);
          if (
            !exact(toolUseId, r.tool_use_id) ||
            seen.has(r.tool_use_id) ||
            typeof r.answer !== "string" ||
            r.answer.length < 1 ||
            [...r.answer].length > 2000
          )
            throw held();
          seen.add(r.tool_use_id);
          return Object.freeze({ toolUseId: r.tool_use_id, answer: r.answer });
        }),
      );
    },
    async turnOpen(input) {
      if (
        !Number.isSafeInteger(input.turn) ||
        input.turn < 1 ||
        input.turn > 16 ||
        (input.attempt !== 1 && input.attempt !== 2) ||
        typeof input.inputCanonical !== "string" ||
        !exact(digest, input.inputDigest) ||
        typeof input.untrusted !== "boolean" ||
        typeof input.readTagsCanonical !== "string"
      )
        throw held();
      const r = one(
        await query(agentRunSql.turnOpen, [
          String(input.turn),
          String(input.attempt),
          input.inputCanonical,
          input.inputDigest,
          String(input.untrusted),
          input.readTagsCanonical,
        ]),
        ["outcome", "reason"],
      );
      if (r.outcome === "stop") {
        if (!["turn_limit", "cost_budget", "wall_time"].includes(r.reason as string)) throw held();
        return Object.freeze({
          outcome: "stop" as const,
          reason: r.reason as "turn_limit" | "cost_budget" | "wall_time",
        });
      }
      if (
        r.reason !== null ||
        !["opened", "opened_before", "conflict", "run_inactive", "invalid", "denied"].includes(
          r.outcome as string,
        )
      )
        throw held();
      return Object.freeze({ outcome: r.outcome }) as TurnOpen;
    },
    async turnSettle(turn, attempt) {
      if (!Number.isSafeInteger(turn) || turn < 1 || turn > 16 || (attempt !== 1 && attempt !== 2))
        throw held();
      const r = one(await query(agentRunSql.turnSettle, [String(turn), String(attempt)]), [
        "outcome",
        "turn_outcome",
        "open_call",
        "last_sequence",
      ]);
      if (r.outcome === "found") {
        if (
          (r.turn_outcome !== null && !turnOutcomes.includes(r.turn_outcome as string)) ||
          (r.open_call !== "none" && r.open_call !== "live")
        )
          throw held();
        return Object.freeze({
          outcome: "found" as const,
          turnOutcome: r.turn_outcome as RecordedTurnOutcome | null,
          openCall: r.open_call,
          lastSequence: integer(r.last_sequence, 0, 8),
        });
      }
      if (
        !["run_inactive", "invalid", "denied"].includes(r.outcome as string) ||
        !allNull(r, ["outcome"])
      )
        throw held();
      return Object.freeze({ outcome: r.outcome as "run_inactive" | "invalid" | "denied" });
    },
    async toolBegin(input) {
      if (
        !Number.isSafeInteger(input.turn) ||
        input.turn < 1 ||
        input.turn > 16 ||
        !Number.isSafeInteger(input.ordinal) ||
        input.ordinal < 0 ||
        input.ordinal > 3 ||
        !exact(toolUseId, input.toolUseId) ||
        !exact(toolName, input.tool) ||
        !exact(digest, input.inputDigest)
      )
        throw held();
      const r = one(
        await query(agentRunSql.toolBegin, [
          String(input.turn),
          String(input.ordinal),
          input.toolUseId,
          input.tool,
          input.inputDigest,
        ]),
        [
          "outcome",
          "refusal",
          "capability_id",
          "verb",
          "replay_class",
          "recorded_outcome",
          "recorded_refusal",
          "record_kind",
          "record_id",
          "result_digest",
        ],
      );
      if (["run_inactive", "invalid", "denied"].includes(r.outcome as string)) {
        if (!allNull(r, ["outcome"])) throw held();
        return Object.freeze({ outcome: r.outcome as "run_inactive" | "invalid" | "denied" });
      }
      if (
        typeof r.capability_id !== "string" ||
        !/^[a-z]+(\.[a-z_]+)+$/.test(r.capability_id) ||
        !["view", "propose", "execute", "delegate"].includes(r.verb as string) ||
        !replayClasses.includes(r.replay_class as string)
      )
        throw held();
      const base = {
        capabilityId: r.capability_id,
        verb: r.verb as string,
        replayClass: r.replay_class as "read" | "internal_write" | "computer",
      };
      if (r.outcome === "begun" || r.outcome === "resumed") {
        if (
          ![r.refusal, r.recorded_outcome, r.recorded_refusal, r.record_kind, r.record_id].every(
            (v) => v === null,
          ) ||
          (r.outcome === "begun" && r.result_digest !== null) ||
          (r.outcome === "resumed" && r.result_digest !== null)
        )
          throw held();
        return Object.freeze({ outcome: r.outcome, ...base });
      }
      if (r.outcome === "refuse") {
        if (r.refusal !== "not_offered" && r.refusal !== "tool_call_limit") throw held();
        return Object.freeze({
          outcome: "refuse" as const,
          refusal: r.refusal,
          ...base,
        });
      }
      if (r.outcome === "replay") {
        if (
          r.refusal !== null ||
          !toolCallOutcomes.includes(r.recorded_outcome as ToolCallOutcome) ||
          (r.recorded_refusal !== null &&
            !toolRefusals.includes(r.recorded_refusal as ToolRefusal)) ||
          (r.record_kind === null) !== (r.record_id === null) ||
          (r.record_kind !== null &&
            (!recordKinds.includes(r.record_kind as string) || !exact(recordId, r.record_id))) ||
          !exact(digest, r.result_digest)
        )
          throw held();
        return Object.freeze({
          outcome: "replay" as const,
          ...base,
          recordedOutcome: r.recorded_outcome as ToolCallOutcome,
          recordedRefusal: r.recorded_refusal as ToolRefusal | null,
          record:
            r.record_kind === null
              ? null
              : Object.freeze({ kind: r.record_kind as RecordKind, id: r.record_id as string }),
          resultDigest: r.result_digest,
        });
      }
      throw held();
    },
    async toolFinish(input) {
      if (
        !exact(toolUseId, input.toolUseId) ||
        !toolCallOutcomes.includes(input.outcome) ||
        (input.refusal !== null && !toolRefusals.includes(input.refusal)) ||
        typeof input.result !== "string" ||
        !exact(digest, input.resultDigest) ||
        (input.record !== null &&
          (!recordKinds.includes(input.record.kind) || !exact(recordId, input.record.id))) ||
        typeof input.untrusted !== "boolean"
      )
        throw held();
      const r = one(
        await query(agentRunSql.toolFinish, [
          input.toolUseId,
          input.outcome,
          input.refusal ?? "",
          input.result,
          input.resultDigest,
          input.record?.kind ?? "",
          input.record?.id ?? "",
          String(input.untrusted),
        ]),
        ["outcome"],
      );
      if (
        !["finished", "replay", "conflict", "run_inactive", "invalid", "denied"].includes(
          r.outcome as string,
        )
      )
        throw held();
      return r.outcome as
        | "finished"
        | "replay"
        | "conflict"
        | "run_inactive"
        | "invalid"
        | "denied";
    },
    async questionAsk(toolUse, question, choicesCanonical) {
      if (
        !exact(toolUseId, toolUse) ||
        typeof question !== "string" ||
        typeof choicesCanonical !== "string"
      )
        throw held();
      const r = one(await query(agentRunSql.questionAsk, [toolUse, question, choicesCanonical]), [
        "outcome",
        "question_id",
      ]);
      if (r.outcome === "asked" || r.outcome === "replay") {
        if (!exact(uuid, r.question_id)) throw held();
        return Object.freeze({ outcome: r.outcome, questionId: r.question_id });
      }
      if (
        !["question_limit", "run_inactive", "invalid", "denied"].includes(r.outcome as string) ||
        r.question_id !== null
      )
        throw held();
      return Object.freeze({
        outcome: r.outcome as "question_limit" | "run_inactive" | "invalid" | "denied",
      });
    },
    async wait() {
      const r = one(await query(agentRunSql.wait), ["outcome", "question_id"]);
      if (r.outcome === "waiting") {
        if (!exact(uuid, r.question_id)) throw held();
        return Object.freeze({ outcome: "waiting" as const, questionId: r.question_id });
      }
      if (
        !["call_open", "run_inactive", "invalid", "denied"].includes(r.outcome as string) ||
        r.question_id !== null
      )
        throw held();
      return Object.freeze({
        outcome: r.outcome as "call_open" | "run_inactive" | "invalid" | "denied",
      });
    },
    async finish(reason) {
      if (!agentRunEndReasons.includes(reason)) throw held();
      const r = one(await query(agentRunSql.finish, [reason]), ["outcome", "status"]);
      if (r.outcome === "ended") {
        if (!["succeeded", "failed", "cancelled"].includes(r.status as string)) throw held();
        return Object.freeze({
          outcome: "ended" as const,
          status: r.status as "succeeded" | "failed" | "cancelled",
        });
      }
      if (!["call_open", "invalid", "denied"].includes(r.outcome as string) || r.status !== null)
        throw held();
      return Object.freeze({ outcome: r.outcome as "call_open" | "invalid" | "denied" });
    },
  };
  return Object.freeze(steps);
}

/** One queued agent run the cron starts (a new Workflow) or resumes (the waiting one). */
export interface AgentPendingStart {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly resume: boolean;
}
/**
 * The cron's ids-only list of queued agent runs (agent_run_pending_starts): at most 100,
 * oldest first. Their leases are also kept out of ListingsRunWorkflow's starts.
 */
export async function listAgentPendingStarts(
  pool: FixedSqlPool,
  attempt: FixedSqlAttempt,
  profile: Parameters<typeof runFixedSqlTransaction>[2],
): Promise<FixedSqlOutcome<readonly AgentPendingStart[]>> {
  return runFixedSqlTransaction(pool, attempt, profile, async (query) => {
    const rows = await query(agentRunSql.pendingStarts);
    if (!Array.isArray(rows) || rows.length > 100) throw held();
    const seen = new Set<string>();
    return Object.freeze(
      rows.map((row) => {
        const r = shape(row, [
          "organization_id",
          "workspace_id",
          "run_id",
          "lease_id",
          "generation",
          "resume",
        ]);
        if (
          !exact(recordId, r.organization_id) ||
          !exact(recordId, r.workspace_id) ||
          !exact(uuid, r.run_id) ||
          !exact(uuid, r.lease_id) ||
          (r.resume !== "true" && r.resume !== "false") ||
          seen.has(r.lease_id)
        )
          throw held();
        seen.add(r.lease_id);
        return Object.freeze({
          organizationId: r.organization_id,
          workspaceId: r.workspace_id,
          runId: r.run_id,
          leaseId: r.lease_id,
          generation: integer(r.generation, 1, Number.MAX_SAFE_INTEGER),
          resume: r.resume === "true",
        });
      }),
    );
  });
}
/** One open agent run's current lease reference (agent_run_resume_lease), or null. */
export async function resolveAgentRunLease(
  pool: FixedSqlPool,
  attempt: FixedSqlAttempt,
  profile: Parameters<typeof runFixedSqlTransaction>[2],
  organizationId: string,
  workspaceId: string,
  runId: string,
): Promise<FixedSqlOutcome<{ readonly leaseId: string; readonly generation: number } | null>> {
  if (!exact(recordId, organizationId) || !exact(recordId, workspaceId) || !exact(uuid, runId))
    return Object.freeze({ ok: true, value: null });
  return runFixedSqlTransaction(pool, attempt, profile, async (query) => {
    const rows = await query(agentRunSql.resumeLease, [organizationId, workspaceId, runId]);
    if (!Array.isArray(rows) || rows.length > 1) throw held();
    if (rows.length === 0) return null;
    const r = shape(rows[0], ["lease_id", "generation"]);
    if (!exact(uuid, r.lease_id)) throw held();
    return Object.freeze({
      leaseId: r.lease_id,
      generation: integer(r.generation, 1, Number.MAX_SAFE_INTEGER),
    });
  });
}
