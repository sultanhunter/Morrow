import { workStatements, type WorkStatementName } from "./sql.js";

// One connection per request, never reused (ADR-0010 item 2). The connector owns
// credentials and transport; this module owns the transaction protocol.
export interface WorkSqlConnection {
  query(
    text: string,
    values: readonly (string | null)[],
    signal: AbortSignal,
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
  close(): Promise<void>;
}
export interface WorkSqlConnector {
  open(c: {
    signal: AbortSignal;
    deadlineMs: number;
    waitUntil(p: Promise<unknown>): void;
  }): Promise<WorkSqlConnection>;
}

/** The command function or COMMIT was sent and its reply is lost: reconcile by command ID. */
export class WorkOutcomeUnknown extends Error {
  constructor() {
    super("WORK_OUTCOME_UNKNOWN");
    this.name = "WorkOutcomeUnknown";
  }
}
/** The database failed before anything that could commit was sent. */
export class WorkSqlUnavailable extends Error {
  constructor() {
    super("WORK_SQL_UNAVAILABLE");
    this.name = "WorkSqlUnavailable";
  }
}

/**
 * A deliberate, fully decided response (denial, conflict or invalid input). The
 * HTTP layer maps each reason to one fixed ErrorEnvelope.
 */
export type WorkRejection =
  | "unauthenticated"
  | "invalid"
  | "denied"
  | "field_denied"
  | "grant_overflow"
  | "not_found"
  | "not_respondent"
  | "store_denied"
  | "revision_conflict"
  | "state_conflict"
  | "guard_failed"
  | "stale_authority"
  | "command_conflict"
  | "target_ineligible"
  | "limit_reached"
  | "unavailable";
export class WorkReject extends Error {
  constructor(readonly reason: WorkRejection) {
    super("WORK_REJECTED");
    this.name = "WorkReject";
  }
}

export interface WorkTx {
  run(
    name: WorkStatementName,
    values: readonly (string | null)[],
  ): Promise<readonly Record<string, unknown>[]>;
  /** Called immediately before the command function is sent. */
  markSubmitted(): void;
  /** The transaction ends with ROLLBACK: a denial or conflict persists nothing. */
  rollbackOnly(): void;
}

export interface WorkTransactionOptions {
  readonly readOnly: boolean;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}

// One READ COMMITTED transaction behind the fixed prologue. A failure after
// markSubmitted() is WorkOutcomeUnknown, never success or denial; any other
// failure is WorkSqlUnavailable unless the body threw its own typed response.
export async function withWorkTransaction<T>(
  c: WorkSqlConnection,
  o: WorkTransactionOptions,
  body: (tx: WorkTx) => Promise<T>,
): Promise<T> {
  const now = o.now ?? Date.now;
  let submitted = false,
    rollback = false,
    open = false;
  const send = async (text: string, values: readonly (string | null)[]) => {
    if (o.signal.aborted || now() >= o.deadlineMs) throw new WorkSqlUnavailable();
    const reply = await c.query(text, values, o.signal);
    if (o.signal.aborted || now() >= o.deadlineMs) throw new WorkSqlUnavailable();
    if (!reply || !Array.isArray(reply.rows)) throw new WorkSqlUnavailable();
    return reply.rows as readonly Record<string, unknown>[];
  };
  const tx: WorkTx = Object.freeze({
    async run(name: WorkStatementName, values: readonly (string | null)[]) {
      if (!Object.hasOwn(workStatements, name) || name.startsWith("prologue"))
        throw new WorkSqlUnavailable();
      if (!values.every((v) => v === null || (typeof v === "string" && !v.includes("\0"))))
        throw new WorkSqlUnavailable();
      return send(workStatements[name], values);
    },
    markSubmitted() {
      submitted = true;
    },
    rollbackOnly() {
      rollback = true;
    },
  });
  try {
    open = true;
    await send(o.readOnly ? workStatements.prologueReadOnly : workStatements.prologueReadWrite, []);
    const value = await body(tx);
    if (rollback) {
      open = false;
      // Nothing that could commit was sent: a lost ROLLBACK reply changes nothing.
      await send(workStatements.rollback, []).catch(() => {});
      return value;
    }
    await send(workStatements.commit, []);
    open = false;
    return value;
  } catch (error) {
    if (open) await send(workStatements.rollback, []).catch(() => {});
    if (submitted && !rollback) throw new WorkOutcomeUnknown();
    if (error instanceof WorkOutcomeUnknown || error instanceof WorkSqlUnavailable) throw error;
    if (error instanceof WorkReject) throw error;
    throw new WorkSqlUnavailable();
  }
}
