// One shared runner for a fixed, source-owned SQL transaction (P05.T01x section 8):
// BEGIN [READ ONLY] -> exact role row -> SET LOCAL timeouts -> fixed statements ->
// COMMIT. Any failure rolls back when nothing is in flight, otherwise discards the
// client. It returns {ok, value} or {ok: false}; it never decides "unknown". The
// caller's own latch (markSubmitted) maps a failure after submission to an unknown
// outcome. Every underlying client is disposable and its release is awaited.

export interface FixedSqlControl {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
export interface FixedSqlClient {
  query(
    text: string,
    values: readonly string[],
    control: Readonly<FixedSqlControl>,
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(discard: boolean): Promise<void>;
}
export interface FixedSqlPool {
  connect(control: Readonly<FixedSqlControl>): Promise<FixedSqlClient>;
}
// The request-owned attempt: one original deadline and cancellation signal.
export interface FixedSqlAttempt {
  readonly control: Readonly<FixedSqlControl>;
  check(): number;
  wait<T>(pending: Promise<T>): Promise<T>;
}
export interface FixedSqlTransactionProfile {
  readonly begin: string;
  readonly role: string;
  readonly settings: readonly string[];
  readonly commit: string;
  readonly rollback: string;
  // Throws unless the role row is exactly the expected safe executor.
  readonly requireRole: (rows: readonly Record<string, unknown>[]) => void;
}
export type FixedSqlQuery = (
  text: string,
  values?: readonly string[],
) => Promise<readonly Record<string, unknown>[]>;
export type FixedSqlOutcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

const unavailable = () => Error("FIXED_SQL_UNAVAILABLE");
const failed: Readonly<{ ok: false }> = Object.freeze({ ok: false });

export async function runFixedSqlTransaction<T>(
  pool: FixedSqlPool,
  attempt: FixedSqlAttempt,
  profile: Readonly<FixedSqlTransactionProfile>,
  body: (query: FixedSqlQuery) => Promise<T>,
): Promise<FixedSqlOutcome<T>> {
  let owned: FixedSqlClient | undefined,
    disposal: Promise<void> | undefined,
    closed = false,
    open = false,
    inFlight = false;
  const dispose = () => {
    closed = true;
    if (owned && !disposal) {
      const client = owned;
      disposal = Promise.resolve().then(() => client.release(true));
      void disposal.catch(() => {});
    }
    return disposal;
  };
  const onAbort = () => void dispose();
  attempt.control.signal.addEventListener("abort", onAbort, { once: true });
  const query: FixedSqlQuery = async (text, values = Object.freeze([])) => {
    attempt.check();
    if (closed || !owned || inFlight) throw unavailable();
    inFlight = true;
    try {
      const pending = Promise.resolve(
        owned.query(text, Object.freeze([...values]), attempt.control),
      );
      void pending.catch(() => {});
      const result = await attempt.wait(pending);
      // Only an acknowledged statement clears the in-flight latch; a lost reply
      // leaves the transaction state unknown and the client is discarded.
      inFlight = false;
      attempt.check();
      if (closed) throw unavailable();
      if (!result || !Array.isArray(result.rows)) throw unavailable();
      return result.rows;
    } catch (error) {
      if (inFlight) dispose();
      throw error;
    }
  };
  try {
    attempt.check();
    const connecting = Promise.resolve(pool.connect(attempt.control)).then((client) => {
      owned = client;
      if (closed || attempt.control.signal.aborted) {
        dispose();
        throw unavailable();
      }
      return client;
    });
    void connecting.catch(() => {});
    await attempt.wait(connecting);
    attempt.check();
    open = true;
    await query(profile.begin);
    profile.requireRole(await query(profile.role));
    for (const setting of profile.settings) await query(setting);
    const value = await body(query);
    attempt.check();
    await query(profile.commit);
    open = false;
    const pending = dispose();
    if (!pending) throw unavailable();
    await attempt.wait(pending);
    attempt.check();
    return Object.freeze({ ok: true, value });
  } catch {
    if (owned && open && !inFlight && !closed && !attempt.control.signal.aborted) {
      try {
        await query(profile.rollback);
        open = false;
      } catch {
        // Unknown work is discarded, never retried.
      }
    }
    const pending = dispose();
    if (pending && !attempt.control.signal.aborted) {
      try {
        await attempt.wait(pending);
      } catch {
        // A disposal failure never replaces the original failure.
      }
    }
    return failed;
  } finally {
    attempt.control.signal.removeEventListener("abort", onAbort);
    dispose();
  }
}
