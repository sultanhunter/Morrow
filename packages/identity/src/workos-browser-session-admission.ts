import { CROSS_CLOCK_ALLOWANCE_MS } from "./clock-allowance.js";
import { executorRoleMemberSql } from "./executor-role-preflight.js";
import type { WorkosAuthenticationEvidence } from "./workos-authentication-evidence.js";
import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";

// The closed reason of a held admit() (the sign-in stage diagnostic). prepare: before a
// connection was requested (selector, command ledger, secret and digests); connect: the pool;
// session_setup: BEGIN and the two SET LOCAL timeouts; role: the executor preflight;
// admit_query: the admission statement; decode_shape: its reply's closed row; decode_lifetime:
// the reply's expiry; denied and conflict: the database's answer (a replayed or locally
// repeated command is a conflict); commit; release; deadline: the attempt deadline, the
// evidence lease, an abort or the clock.
export const browserSessionAdmissionHeldCodes = Object.freeze([
  "prepare",
  "connect",
  "session_setup",
  "role",
  "admit_query",
  "decode_shape",
  "decode_lifetime",
  "denied",
  "conflict",
  "commit",
  "release",
  "deadline",
] as const);
export type BrowserSessionAdmissionHeldCode = (typeof browserSessionAdmissionHeldCodes)[number];
// decode_lifetime only: how far the reply's expiry lay past the Worker's now + 30 minutes, in
// coarse buckets, or "expired" when it was not after the Worker's now. Never the value itself.
export const browserSessionAdmissionLifetimeLeads = Object.freeze([
  "expired",
  "lead_le_1s",
  "lead_le_5s",
  "lead_le_60s",
  "lead_gt_60s",
] as const);
export type BrowserSessionAdmissionLifetimeLead =
  (typeof browserSessionAdmissionLifetimeLeads)[number];
export type BrowserSessionAdmissionHeld = Readonly<{
  sub: BrowserSessionAdmissionHeldCode;
  lead: BrowserSessionAdmissionLifetimeLead | null;
}>;
export interface BrowserSessionAdmissionControl {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
export interface BrowserSessionAdmissionSqlClient {
  query(
    text: string,
    values: readonly string[],
    control: Readonly<BrowserSessionAdmissionControl>,
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(discard: boolean): Promise<void>;
}
export interface BrowserSessionAdmissionSqlPool {
  connect(
    control: Readonly<BrowserSessionAdmissionControl>,
  ): Promise<BrowserSessionAdmissionSqlClient>;
}
export interface BrowserSessionAdmissionDependencies {
  readonly readEvidence: (handle: unknown) => Readonly<WorkosAuthenticationEvidence> | null;
  readonly pool: BrowserSessionAdmissionSqlPool;
  readonly now: () => number;
  readonly signal?: AbortSignal;
  // Called once per held admit() with closed values only; never for reconcile(). It cannot
  // change the result: a throw is swallowed.
  readonly onHeld?: (held: BrowserSessionAdmissionHeld) => void;
}
export interface BrowserSessionAdmissionCorrelation {
  readonly commandId: string;
  readonly requestDigest: string;
}
export interface PrivateBrowserSessionCredential {
  readonly secret: string;
  readonly familyId: string;
  readonly generationId: string;
  readonly providerBindingId: string;
  readonly expiresAtMs: number;
  readonly auditId: string;
}
export type BrowserSessionAdmissionResult = Readonly<{
  outcome: "newly_admitted" | "held";
  credential: Readonly<PrivateBrowserSessionCredential> | null;
  correlation: Readonly<BrowserSessionAdmissionCorrelation> | null;
}>;
export type BrowserSessionReconciliationResult = Readonly<{
  outcome: "replayed" | "denied" | "conflict" | "held";
  attribution: Omit<Readonly<PrivateBrowserSessionCredential>, "secret"> | null;
  correlation: Readonly<BrowserSessionAdmissionCorrelation> | null;
}>;
export const browserSessionAdmissionSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED",
  readOnlyBegin: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  role: `SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,
pg_catalog.pg_has_role(current_user,'morrow_identity_owner','MEMBER') AS owner_member,
${executorRoleMemberSql}
FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  timeout: "SET LOCAL statement_timeout = '1s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '5s'",
  admit:
    "SELECT outcome,family_id,generation_id,provider_binding_id,expires_at_ms,audit_id FROM morrow_identity.admit_browser_family($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)",
  reconcile:
    "SELECT outcome,family_id,generation_id,provider_binding_id,expires_at_ms,audit_id FROM morrow_identity.reconcile_browser_admission($1,$2)",
  // Account admission (0013): no workspace, mapping or membership selector. An unmapped
  // verified subject may enroll in the same transaction while enrollment is enabled.
  admitAccount:
    "SELECT outcome,family_id,generation_id,provider_binding_id,expires_at_ms,audit_id FROM morrow_identity.admit_account_family($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)",
  reconcileAccount:
    "SELECT outcome,family_id,generation_id,provider_binding_id,expires_at_ms,audit_id FROM morrow_identity.reconcile_account_admission($1,$2)",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
const fail = () => Error("BROWSER_SESSION_ADMISSION_HELD");
const recordId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
const revision = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
function closed(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).sort().join(",") !== [...names].sort().join(",")) throw fail();
  const copy: Record<string, unknown> = {};
  for (const name of names) {
    const d = descriptors[name];
    if (!d || !Object.hasOwn(d, "value")) throw fail();
    Object.defineProperty(copy, name, { value: d.value, enumerable: true });
  }
  return Object.freeze(copy);
}
function onlyRow(value: unknown) {
  const rows = closed(value, ["rows"]).rows;
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(rows);
  if (
    Reflect.ownKeys(rows).sort().join(",") !== "0,length" ||
    Object.getOwnPropertyDescriptor(rows, "length")?.value !== 1 ||
    !descriptors["0"] ||
    !Object.hasOwn(descriptors["0"], "value")
  )
    throw fail();
  return descriptors["0"].value as unknown;
}
const evidenceKeys = [
  "providerId",
  "environmentId",
  "applicationId",
  "clientId",
  "issuer",
  "subjectId",
  "providerSessionId",
  "tokenProvenance",
  "sessionClientBinding",
  "sessionLiveness",
  "issuedAtMs",
  "observedAtMs",
  "expiresAtMs",
  "tokenProfileRevision",
  "tokenProfileDigest",
  "keySetDigest",
  "observationProfileDigest",
] as const;
function evidence(value: unknown): Readonly<WorkosAuthenticationEvidence> {
  const v = closed(value, evidenceKeys);
  if (
    v.providerId !== "workos" ||
    typeof v.environmentId !== "string" ||
    !/^environment_[A-Z0-9]{26}$/.test(v.environmentId) ||
    typeof v.applicationId !== "string" ||
    !/^app_[A-Z0-9]{26}$/.test(v.applicationId) ||
    typeof v.clientId !== "string" ||
    !/^client_[A-Z0-9]{26}$/.test(v.clientId) ||
    v.issuer !== `https://api.workos.com/user_management/${v.clientId}` ||
    typeof v.subjectId !== "string" ||
    !/^user_[A-Z0-9]{26}$/.test(v.subjectId) ||
    typeof v.providerSessionId !== "string" ||
    !/^session_[A-Z0-9]{26}$/.test(v.providerSessionId) ||
    v.tokenProvenance !== "signature_verified" ||
    v.sessionClientBinding !== "expected_only" ||
    v.sessionLiveness !== "not_guaranteed" ||
    !time(v.issuedAtMs) ||
    !time(v.observedAtMs) ||
    !time(v.expiresAtMs) ||
    !revision(v.tokenProfileRevision) ||
    !digest(v.tokenProfileDigest) ||
    !digest(v.keySetDigest) ||
    !digest(v.observationProfileDigest)
  )
    throw fail();
  return v as unknown as Readonly<WorkosAuthenticationEvidence>;
}
const selectorKeys = [
  "schemaVersion",
  "commandId",
  "workspaceId",
  "profileId",
  "profileRecordRevision",
  "mappingId",
  "mappingRevision",
  "bindingRevision",
  "membershipId",
  "policyRevision",
] as const;
const accountSelectorKeys = [
  "schemaVersion",
  "commandId",
  "profileId",
  "profileRecordRevision",
] as const;
function accountSelector(text: unknown) {
  const v = closed(parseWorkosSessionStatusJson(text, 2048), accountSelectorKeys);
  if (
    v.schemaVersion !== 1 ||
    !uuid(v.commandId) ||
    !recordId(v.profileId) ||
    !revision(v.profileRecordRevision)
  )
    throw fail();
  return v;
}
function selector(text: unknown) {
  const v = closed(parseWorkosSessionStatusJson(text, 2048), selectorKeys);
  if (
    v.schemaVersion !== 1 ||
    !uuid(v.commandId) ||
    ![v.workspaceId, v.profileId, v.mappingId, v.membershipId].every(recordId) ||
    ![v.profileRecordRevision, v.mappingRevision, v.bindingRevision, v.policyRevision].every(
      revision,
    )
  )
    throw fail();
  return v;
}
function requireRole(value: unknown) {
  const names = [
    "role",
    "login",
    "rolsuper",
    "rolbypassrls",
    "rolcreatedb",
    "rolcreaterole",
    "rolreplication",
    "rolinherit",
    "owner_member",
    "role_member",
  ];
  const v = closed(onlyRow(value), names);
  if (
    v.role !== "morrow_identity_sessions" ||
    v.login !== "morrow_identity_sessions" ||
    names.slice(2).some((n) => v[n] !== false)
  )
    throw fail();
}
type Attribution = Omit<Readonly<PrivateBrowserSessionCredential>, "secret">;
const lifetimeLead = (expiry: number, at: number): BrowserSessionAdmissionLifetimeLead => {
  if (expiry <= at) return "expired";
  const lead = expiry - (at + 1800000);
  return lead <= 1000
    ? "lead_le_1s"
    : lead <= 5000
      ? "lead_le_5s"
      : lead <= 60000
        ? "lead_le_60s"
        : "lead_gt_60s";
};
// P05.T01y (ADR-0004): a new generation expires 30 minutes after its admission instant. The
// database sets expiry = n + 30 minutes from its own clock_timestamp() n (0016
// browser_new_lifetimes) and admits only while n is before the evidence lease end
// (admit_account_family and admit_browser_family: p_evidence_expires > n, rechecked after the
// writes), so an honest reply's expiry is before that lease end + 30 minutes. The Worker reads
// `at` from its own clock after the reply, and the database's clock may lead it: comparing
// with at + 30 minutes alone refused every reply whose clock lead exceeded the reply latency.
// The bound is the SQL's own guarantee, and never more than CROSS_CLOCK_ALLOWANCE_MS past
// at + 30 minutes. The cookie cap (1800 s) and the database's triggers stay the authority.
const newGenerationExpiryValid = (expiry: number, at: number, evidenceExpiresAtMs: number) =>
  time(evidenceExpiresAtMs) &&
  expiry > at &&
  expiry < Math.min(evidenceExpiresAtMs, at + CROSS_CLOCK_ALLOWANCE_MS) + 1800000;
function decode(
  value: unknown,
  at: number,
  evidenceExpiresAtMs?: number,
  generated?: readonly string[],
  onLifetime?: (lead: BrowserSessionAdmissionLifetimeLead) => void,
): {
  outcome: "newly_admitted" | "replayed" | "denied" | "conflict";
  attribution: Attribution | null;
} {
  const v = closed(onlyRow(value), [
    "outcome",
    "family_id",
    "generation_id",
    "provider_binding_id",
    "expires_at_ms",
    "audit_id",
  ]);
  if (!["newly_admitted", "replayed", "denied", "conflict"].includes(v.outcome as string))
    throw fail();
  const outcome = v.outcome as "newly_admitted" | "replayed" | "denied" | "conflict";
  const terminal = [
    v.family_id,
    v.generation_id,
    v.provider_binding_id,
    v.expires_at_ms,
    v.audit_id,
  ];
  if (outcome === "denied" || outcome === "conflict") {
    if (terminal.some((x) => x !== null)) throw fail();
    return { outcome, attribution: null };
  }
  if (
    ![v.family_id, v.generation_id, v.provider_binding_id, v.audit_id].every(uuid) ||
    typeof v.expires_at_ms !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(v.expires_at_ms)
  )
    throw fail();
  const expiry = Number(v.expires_at_ms);
  if (
    !time(expiry) ||
    (generated && (v.family_id !== generated[0] || v.generation_id !== generated[1]))
  )
    throw fail();
  if (outcome === "newly_admitted") {
    // Only an admission with its evidence lease can carry a new generation.
    if (evidenceExpiresAtMs === undefined) throw fail();
    if (!newGenerationExpiryValid(expiry, at, evidenceExpiresAtMs)) {
      onLifetime?.(lifetimeLead(expiry, at));
      throw fail();
    }
  }
  return {
    outcome,
    attribution: Object.freeze({
      familyId: v.family_id as string,
      generationId: v.generation_id as string,
      providerBindingId: v.provider_binding_id as string,
      expiresAtMs: expiry,
      auditId: v.audit_id as string,
    }),
  };
}
async function sha(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
const held = (
  correlation: Readonly<BrowserSessionAdmissionCorrelation> | null,
): BrowserSessionAdmissionResult =>
  Object.freeze({ outcome: "held", credential: null, correlation });
// This is a private local issuer boundary, not an HTTP/cookie/provider adapter.
export function createWorkosBrowserSessionAdmission(
  dependencies: BrowserSessionAdmissionDependencies,
) {
  return createAdmission(dependencies, "workspace");
}
// The account sibling (P05.T01x): the same attempt, release and uncertainty machinery and
// result types, with the 20-element account tuple and no workspace authority.
export function createWorkosAccountAdmission(dependencies: BrowserSessionAdmissionDependencies) {
  return createAdmission(dependencies, "account");
}
function createAdmission(
  dependencies: BrowserSessionAdmissionDependencies,
  mode: "workspace" | "account",
) {
  let readEvidence: BrowserSessionAdmissionDependencies["readEvidence"],
    pool: BrowserSessionAdmissionSqlPool,
    now: () => number,
    signal: AbortSignal | undefined,
    onHeld: BrowserSessionAdmissionDependencies["onHeld"];
  try {
    ({ readEvidence, pool, now, signal, onHeld } = dependencies);
    if (
      typeof readEvidence !== "function" ||
      typeof pool?.connect !== "function" ||
      typeof now !== "function" ||
      (signal !== undefined && !(signal instanceof AbortSignal)) ||
      (onHeld !== undefined && typeof onHeld !== "function")
    )
      throw fail();
  } catch {
    throw Error("BROWSER_SESSION_ADMISSION_CONFIG_INVALID");
  }
  let lastTime = -1,
    brokenClock = false;
  const commands = new Map<string, Readonly<BrowserSessionAdmissionCorrelation> | null>();
  const clock = () => {
    try {
      const at = now();
      if (brokenClock || !time(at) || at < lastTime) throw fail();
      lastTime = at;
      return at;
    } catch {
      brokenClock = true;
      throw fail();
    }
  };
  type AttemptPhase = Exclude<BrowserSessionAdmissionHeldCode, "denied" | "conflict" | "deadline">;
  type AttemptTools = Readonly<{ check: () => number; mark: (phase: AttemptPhase) => void }>;
  async function attempt<T>(
    fresh: () => number,
    deadline: number,
    readOnly: boolean,
    action: (
      query: (text: string, values?: readonly string[]) => Promise<unknown>,
      tools: AttemptTools,
    ) => Promise<T>,
    prepare?: (check: () => number) => Promise<void>,
    failed?: (code: AttemptPhase | "deadline") => void,
  ): Promise<T> {
    let client: BrowserSessionAdmissionSqlClient | undefined,
      releasePromise: Promise<void> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false,
      open = false,
      uncertain = false,
      commitAttempted = false,
      // Diagnostic only: the step in flight, and whether a time, lease, abort or clock check
      // failed. Neither changes any decision below.
      phase: AttemptPhase = "prepare",
      late = false;
    const mark = (next: AttemptPhase) => {
      phase = next;
    };
    const abort = new AbortController();
    let interrupted!: () => void;
    const interruption = new Promise<{ stopped: true }>((resolve) => {
      interrupted = () => resolve({ stopped: true });
    });
    const dispose = () => {
      if (client && !releasePromise) {
        const owned = client;
        releasePromise = Promise.resolve().then(() => owned.release(true));
        void releasePromise.catch(() => {});
      }
      return releasePromise;
    };
    const stop = () => {
      stopped = true;
      abort.abort();
      interrupted();
      dispose();
    };
    const check = () => {
      let at: number;
      try {
        at = fresh();
      } catch (error) {
        late = true;
        throw error;
      }
      if (stopped || signal?.aborted || at >= deadline) {
        late = true;
        stop();
        throw fail();
      }
      return at;
    };
    const race = async <V>(promise: Promise<V>): Promise<V> => {
      const answer = await Promise.race([promise.then((value) => ({ value })), interruption]);
      if ("stopped" in answer || stopped) throw fail();
      return answer.value;
    };
    const control = Object.freeze({ deadlineMs: deadline, signal: abort.signal });
    const query = async (text: string, values: readonly string[] = Object.freeze([])) => {
      check();
      uncertain = true;
      const pending = Promise.resolve(client!.query(text, values, control)).then((value) => {
        uncertain = false;
        return value;
      });
      void pending.catch(() => {});
      try {
        return await race(pending);
      } finally {
        check();
      }
    };
    const onAbort = stop;
    try {
      const at = check();
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(stop, deadline - at);
      if (prepare) {
        try {
          await race(prepare(check));
        } finally {
          check();
        }
      }
      mark("connect");
      const connecting = Promise.resolve(pool.connect(control)).then((value) => {
        client = value;
        if (stopped || abort.signal.aborted) {
          dispose();
          throw fail();
        }
        return value;
      });
      void connecting.catch(() => {});
      try {
        await race(connecting);
      } finally {
        check();
      }
      open = true;
      mark("session_setup");
      await query(
        readOnly ? browserSessionAdmissionSql.readOnlyBegin : browserSessionAdmissionSql.begin,
      );
      mark("role");
      requireRole(await query(browserSessionAdmissionSql.role));
      mark("session_setup");
      await query(browserSessionAdmissionSql.timeout);
      await query(browserSessionAdmissionSql.idleTimeout);
      mark("admit_query");
      const value = await action(query, Object.freeze({ check, mark }));
      check();
      mark("commit");
      commitAttempted = true;
      await query(browserSessionAdmissionSql.commit);
      open = false;
      mark("release");
      const released = dispose();
      if (!released) throw fail();
      await race(released);
      check();
      return value;
    } catch {
      // The first failure's reason, fixed before any cleanup check can change it.
      const code = late || stopped ? ("deadline" as const) : phase;
      try {
        failed?.(code);
      } catch {
        /* A diagnostic never changes the outcome. */
      }
      if (client && open && !uncertain && !commitAttempted && !stopped && !abort.signal.aborted) {
        try {
          check();
          await query(browserSessionAdmissionSql.rollback);
          open = false;
        } catch {
          /* Unknown work is discarded, never retried. */
        }
      }
      const released = dispose();
      if (released && !stopped) {
        try {
          await race(released);
          check();
        } catch {
          /* No success is issued on ambiguous cleanup. */
        }
      }
      throw fail();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      stop();
    }
  }
  return Object.freeze({
    async admit(handle: unknown, selectorJson: unknown): Promise<BrowserSessionAdmissionResult> {
      let secret: string | undefined,
        correlation: Readonly<BrowserSessionAdmissionCorrelation> | null = null;
      // Diagnostic state for onHeld only; no decision below reads it.
      let attemptCode: BrowserSessionAdmissionHeldCode | undefined,
        lead: BrowserSessionAdmissionLifetimeLead | null = null,
        late = false;
      const report = (sub: BrowserSessionAdmissionHeldCode) => {
        try {
          onHeld?.(Object.freeze({ sub, lead: sub === "decode_lifetime" ? lead : null }));
        } catch {
          /* A diagnostic never changes the outcome. */
        }
      };
      const timed = <V>(read: () => V): V => {
        try {
          return read();
        } catch (error) {
          late = true;
          throw error;
        }
      };
      try {
        const started = timed(clock),
          selected = mode === "account" ? accountSelector(selectorJson) : selector(selectorJson),
          commandId = selected.commandId as string;
        if (commands.has(commandId)) {
          report("conflict");
          return held(commands.get(commandId) ?? null);
        }
        if (commands.size >= 1024) {
          report("prepare");
          return held(null);
        }
        let original: Readonly<WorkosAuthenticationEvidence> | undefined,
          deadline = 0;
        const observe = () => {
          clock();
          let value: Readonly<WorkosAuthenticationEvidence>;
          try {
            value = evidence(readEvidence(handle));
          } finally {
            clock();
          }
          const at = clock();
          if (
            signal?.aborted ||
            at >= value.expiresAtMs ||
            (deadline && at >= deadline) ||
            (original && evidenceKeys.some((k) => value[k] !== original![k]))
          )
            throw fail();
          original ??= value;
          return at;
        };
        const fresh = () => timed(observe);
        fresh();
        deadline = Math.min(started + 5000, original!.expiresAtMs);
        fresh();
        commands.set(commandId, null);
        let familyId = "",
          generationId = "";
        let values: readonly string[] = Object.freeze([]);
        const admitted = await attempt(
          fresh,
          deadline,
          false,
          async (query, { check, mark }) => {
            const reply = await query(
              mode === "account"
                ? browserSessionAdmissionSql.admitAccount
                : browserSessionAdmissionSql.admit,
              values,
            );
            const at = check();
            mark("decode_shape");
            return decode(reply, at, original!.expiresAtMs, [familyId, generationId], (bucket) => {
              lead = bucket;
              mark("decode_lifetime");
            });
          },
          async (check) => {
            const random = crypto.getRandomValues(new Uint8Array(32));
            try {
              secret = btoa(String.fromCharCode(...random))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replace(/=+$/, "");
            } finally {
              random.fill(0);
            }
            familyId = crypto.randomUUID();
            generationId = crypto.randomUUID();
            if (familyId === generationId) throw fail();
            const secretDigest = await sha(secret);
            check();
            const e = original!;
            const tuple = Object.freeze(
              mode === "account"
                ? [
                    commandId,
                    e.providerId,
                    e.environmentId,
                    e.applicationId,
                    e.clientId,
                    e.issuer,
                    String(e.tokenProfileRevision),
                    e.tokenProfileDigest,
                    e.subjectId,
                    e.providerSessionId,
                    String(e.issuedAtMs),
                    String(e.observedAtMs),
                    String(e.expiresAtMs),
                    e.keySetDigest,
                    e.observationProfileDigest,
                    secretDigest,
                    selected.profileId as string,
                    String(selected.profileRecordRevision),
                    familyId,
                    generationId,
                  ]
                : [
                    commandId,
                    e.providerId,
                    e.environmentId,
                    e.applicationId,
                    e.clientId,
                    e.issuer,
                    String(e.tokenProfileRevision),
                    e.tokenProfileDigest,
                    e.subjectId,
                    e.providerSessionId,
                    selected.workspaceId as string,
                    String(e.issuedAtMs),
                    String(e.observedAtMs),
                    String(e.expiresAtMs),
                    e.keySetDigest,
                    e.observationProfileDigest,
                    secretDigest,
                    selected.profileId as string,
                    String(selected.profileRecordRevision),
                    selected.mappingId as string,
                    String(selected.mappingRevision),
                    String(selected.bindingRevision),
                    selected.membershipId as string,
                    String(selected.policyRevision),
                    familyId,
                    generationId,
                  ],
            );
            const requestDigest = await sha(JSON.stringify(tuple));
            check();
            correlation = Object.freeze({ commandId, requestDigest });
            commands.set(commandId, correlation);
            values = Object.freeze([commandId, requestDigest, ...tuple.slice(1)]);
          },
          (code) => {
            attemptCode = code;
          },
        );
        const at = fresh();
        if (typeof secret !== "string") {
          report("prepare");
          return held(correlation);
        }
        if (admitted.outcome !== "newly_admitted") {
          // A replayed command was already used, as a conflicting one was.
          report(admitted.outcome === "denied" ? "denied" : "conflict");
          return held(correlation);
        }
        if (!admitted.attribution) {
          report("decode_shape");
          return held(correlation);
        }
        if (at >= admitted.attribution.expiresAtMs) {
          lead = "expired";
          report("decode_lifetime");
          return held(correlation);
        }
        return Object.freeze({
          outcome: "newly_admitted",
          credential: Object.freeze({ secret, ...admitted.attribution }),
          correlation,
        });
      } catch {
        report(attemptCode ?? (late ? "deadline" : "prepare"));
        return held(correlation);
      } finally {
        secret = undefined;
      }
    },
    async reconcile(selectorJson: unknown): Promise<BrowserSessionReconciliationResult> {
      let correlation: Readonly<BrowserSessionAdmissionCorrelation> | null = null;
      try {
        const started = clock(),
          s = closed(parseWorkosSessionStatusJson(selectorJson, 2048), [
            "schemaVersion",
            "commandId",
            "requestDigest",
          ]);
        if (s.schemaVersion !== 1 || !uuid(s.commandId) || !digest(s.requestDigest)) throw fail();
        correlation = Object.freeze({ commandId: s.commandId, requestDigest: s.requestDigest });
        const deadline = Math.min(started + 5000, 8640000000000000);
        const fresh = () => {
          const at = clock();
          if (signal?.aborted || at >= deadline) throw fail();
          return at;
        };
        const decoded = await attempt(fresh, deadline, true, async (query) => {
          const row = decode(
            await query(
              mode === "account"
                ? browserSessionAdmissionSql.reconcileAccount
                : browserSessionAdmissionSql.reconcile,
              Object.freeze([s.commandId as string, s.requestDigest as string]),
            ),
            fresh(),
          );
          if (row.outcome === "newly_admitted") throw fail();
          return row;
        });
        fresh();
        return Object.freeze({
          outcome: decoded.outcome as "replayed" | "denied" | "conflict",
          attribution: decoded.attribution,
          correlation,
        });
      } catch {
        return Object.freeze({ outcome: "held", attribution: null, correlation });
      }
    },
  });
}
