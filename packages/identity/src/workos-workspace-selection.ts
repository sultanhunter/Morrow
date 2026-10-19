import { executorRoleMemberSql } from "./executor-role-preflight.js";
import type { WorkosAuthenticationEvidence } from "./workos-authentication-evidence.js";
import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";

export interface WorkspaceSelectionControl {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
export interface WorkspaceSelectionSqlClient {
  query(
    text: string,
    values: readonly string[],
    control: Readonly<WorkspaceSelectionControl>,
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  // Dedicated disposable connections only: true must cancel pending work,
  // destroy the connection and settle after closure. Repeated true is idempotent.
  release(discard: boolean): Promise<void>;
}
export interface WorkspaceSelectionSqlPool {
  connect(control: Readonly<WorkspaceSelectionControl>): Promise<WorkspaceSelectionSqlClient>;
}
export interface WorkosWorkspaceSelectionDependencies {
  readonly readEvidence: (handle: unknown) => Readonly<WorkosAuthenticationEvidence> | null;
  readonly pool: WorkspaceSelectionSqlPool;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}
export interface PrivateWorkspaceSelection {
  readonly kind: "private_workspace_selection";
  readonly profileId: string;
  readonly profileRecordRevision: number;
  readonly mappingId: string;
  readonly mappingRevision: number;
  readonly bindingRevision: number;
  readonly principalId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly policyRevision: number;
  readonly observedAtMs: number;
  readonly evidenceExpiresAtMs: number;
}
export type WorkosWorkspaceSelectionResult =
  | Readonly<{ outcome: "selected"; selection: Readonly<PrivateWorkspaceSelection> }>
  | Readonly<{ outcome: "held"; selection: null }>;

export const workspaceSelectionSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  role: `SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,
pg_catalog.pg_has_role(current_user,'morrow_identity_owner','MEMBER') AS owner_member,
${executorRoleMemberSql}
FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  timeout: "SET LOCAL statement_timeout = '1s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '5s'",
  resolve:
    "SELECT profile_id,profile_record_revision,mapping_id,mapping_revision,binding_revision,principal_id,organization_id,workspace_id,membership_id,policy_revision FROM morrow_identity.resolve_provider_subject_selection($1,$2,$3,$4,$5,$6,$7,$8,$9)",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
const held = Object.freeze({ outcome: "held" as const, selection: null });
const fail = () => Error("WORKOS_WORKSPACE_SELECTION_HELD");
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const clockValue = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8640000000000000;
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(value);
  if (
    names.some((name) => typeof name !== "string") ||
    names.sort().join(",") !== [...keys].sort().join(",")
  )
    throw fail();
  const snapshot: Record<string, unknown> = {};
  for (const name of keys) {
    const descriptor = descriptors[name];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw fail();
    Object.defineProperty(snapshot, name, { value: descriptor.value, enumerable: true });
  }
  return Object.freeze(snapshot);
}
const rowKeys = [
  "profile_id",
  "profile_record_revision",
  "mapping_id",
  "mapping_revision",
  "binding_revision",
  "principal_id",
  "organization_id",
  "workspace_id",
  "membership_id",
  "policy_revision",
] as const;
const rowNames = [
  "profileId",
  "profileRecordRevision",
  "mappingId",
  "mappingRevision",
  "bindingRevision",
  "principalId",
  "organizationId",
  "workspaceId",
  "membershipId",
  "policyRevision",
] as const;
function revision(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) throw fail();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > 9007199254740991) throw fail();
  return n;
}
type SelectionRow = Omit<
  PrivateWorkspaceSelection,
  "kind" | "observedAtMs" | "evidenceExpiresAtMs"
>;
function onlyRow(value: unknown): unknown {
  const outer = closed(value, ["rows"]),
    rows = outer.rows;
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(rows);
  if (
    Reflect.ownKeys(rows).sort().join(",") !== "0,length" ||
    !Object.hasOwn(descriptors["0"]!, "value") ||
    Object.getOwnPropertyDescriptor(rows, "length")?.value !== 1
  )
    throw fail();
  return descriptors["0"]!.value;
}
function decode(value: unknown, workspaceId: string): Readonly<SelectionRow> {
  const row = closed(onlyRow(value), rowKeys);
  const result: Record<string, unknown> = {};
  for (let n = 0; n < rowKeys.length; n++) {
    const key = rowKeys[n]!,
      name = rowNames[n]!;
    const value = row[key];
    if (key.endsWith("revision")) result[name] = revision(value);
    else {
      if (!id(value)) throw fail();
      result[name] = value;
    }
  }
  if (result.workspaceId !== workspaceId) throw fail();
  return Object.freeze(result) as unknown as Readonly<SelectionRow>;
}
function requireRole(value: unknown) {
  const keys = [
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
  const role = closed(onlyRow(value), keys);
  if (
    role.role !== "morrow_identity_resolution" ||
    role.login !== "morrow_identity_resolution" ||
    keys.slice(2).some((name) => role[name] !== false)
  )
    throw fail();
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
function evidenceSnapshot(value: unknown): Readonly<WorkosAuthenticationEvidence> {
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
    !clockValue(v.issuedAtMs) ||
    !clockValue(v.observedAtMs) ||
    !clockValue(v.expiresAtMs) ||
    !Number.isSafeInteger(v.tokenProfileRevision) ||
    (v.tokenProfileRevision as number) < 1 ||
    !digest(v.tokenProfileDigest) ||
    !digest(v.keySetDigest) ||
    !digest(v.observationProfileDigest)
  )
    throw fail();
  return v as unknown as Readonly<WorkosAuthenticationEvidence>;
}

// Non-authorizing snapshot only. No SQL freshness is promised after the last
// lookup; a future issuer must lock/revalidate records in its own transaction.
export function createWorkosWorkspaceSelection(dependencies: WorkosWorkspaceSelectionDependencies) {
  let readEvidence: WorkosWorkspaceSelectionDependencies["readEvidence"],
    pool: WorkspaceSelectionSqlPool,
    now: () => number,
    signal: AbortSignal | undefined;
  try {
    ({ readEvidence, pool, now, signal } = dependencies);
    if (
      typeof readEvidence !== "function" ||
      typeof pool?.connect !== "function" ||
      typeof now !== "function" ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    )
      throw fail();
  } catch {
    throw Error("WORKOS_WORKSPACE_SELECTION_CONFIG_INVALID");
  }
  let previousTime = -1,
    clockBroken = false;
  const readClock = () => {
    try {
      const at: unknown = now();
      if (clockBroken || !clockValue(at) || at < previousTime) throw fail();
      previousTime = at;
      return at;
    } catch {
      clockBroken = true;
      throw fail();
    }
  };
  return Object.freeze({
    async resolve(handle: unknown, selectorJson: unknown): Promise<WorkosWorkspaceSelectionResult> {
      let client: WorkspaceSelectionSqlClient | undefined;
      let releasePromise: Promise<void> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onCancel: (() => void) | undefined;
      let open = false,
        commitAttempted = false,
        queryUncertain = false,
        closedAttempt = false;
      const abort = new AbortController();
      let interrupt!: () => void;
      const interrupted = new Promise<{ interrupted: true }>((resolve) => {
        interrupt = () => resolve({ interrupted: true });
      });
      const dispose = () => {
        if (client && !releasePromise) {
          const ownedClient = client;
          // Publish the promise before invoking the adapter. A synchronous
          // cancellation callback during release cannot invoke it twice.
          releasePromise = Promise.resolve().then(() => ownedClient.release(true));
          void releasePromise.catch(() => {});
        }
        return releasePromise;
      };
      const stop = () => {
        closedAttempt = true;
        abort.abort();
        interrupt();
        dispose();
      };
      const race = async <T>(pending: Promise<T>): Promise<T> => {
        const result = await Promise.race([pending.then((value) => ({ value })), interrupted]);
        if ("interrupted" in result || closedAttempt) throw fail();
        return result.value;
      };
      let original: Readonly<WorkosAuthenticationEvidence>;
      let deadline = 0;
      const fresh = () => {
        try {
          if (closedAttempt) throw fail();
          readClock();
          let value: Readonly<WorkosAuthenticationEvidence>;
          try {
            value = evidenceSnapshot(readEvidence(handle));
          } finally {
            readClock();
          }
          const at = readClock();
          if (
            signal?.aborted ||
            at >= value.expiresAtMs ||
            (deadline !== 0 && at >= deadline) ||
            (original !== undefined && evidenceKeys.some((key) => value[key] !== original[key]))
          )
            throw fail();
          return { value, at };
        } catch {
          stop();
          throw fail();
        }
      };
      try {
        const started = readClock();
        const selector = closed(parseWorkosSessionStatusJson(selectorJson, 2048), [
          "schemaVersion",
          "workspaceId",
        ]);
        if (selector.schemaVersion !== 1 || !id(selector.workspaceId)) throw fail();
        const workspaceId = selector.workspaceId;
        const initial = fresh();
        original = initial.value;
        deadline = Math.min(started + 5000, original.expiresAtMs);
        const checked = fresh();
        const control = Object.freeze({ deadlineMs: deadline, signal: abort.signal });
        onCancel = stop;
        signal?.addEventListener("abort", onCancel, { once: true });
        timer = setTimeout(stop, deadline - checked.at);
        const connecting = Promise.resolve(pool.connect(control)).then((connected) => {
          client = connected;
          if (closedAttempt || abort.signal.aborted) {
            dispose();
            throw fail();
          }
          return connected;
        });
        void connecting.catch(() => {});
        fresh();
        try {
          await race(connecting);
        } finally {
          fresh();
        }
        const query = async (text: string, values: readonly string[] = []) => {
          fresh();
          queryUncertain = true;
          const pending = Promise.resolve(client!.query(text, values, control)).then((value) => {
            queryUncertain = false;
            return value;
          });
          void pending.catch(() => {});
          fresh();
          try {
            return await race(pending);
          } finally {
            fresh();
          }
        };
        open = true;
        await query(workspaceSelectionSql.begin);
        requireRole(await query(workspaceSelectionSql.role));
        await query(workspaceSelectionSql.timeout);
        await query(workspaceSelectionSql.idleTimeout);
        const values = Object.freeze([
          original.providerId,
          original.environmentId,
          original.applicationId,
          original.clientId,
          original.issuer,
          String(original.tokenProfileRevision),
          original.tokenProfileDigest,
          original.subjectId,
          workspaceId,
        ]);
        const first = decode(await query(workspaceSelectionSql.resolve, values), workspaceId);
        const last = decode(await query(workspaceSelectionSql.resolve, values), workspaceId);
        const observedAtMs = fresh().at;
        if (rowNames.some((key) => first[key] !== last[key])) throw fail();
        commitAttempted = true;
        await query(workspaceSelectionSql.commit);
        open = false;
        const released = dispose();
        if (!released) throw fail();
        await race(released);
        fresh();
        return Object.freeze({
          outcome: "selected",
          selection: Object.freeze({
            kind: "private_workspace_selection",
            ...last,
            observedAtMs,
            evidenceExpiresAtMs: original.expiresAtMs,
          }),
        });
      } catch {
        if (
          client &&
          open &&
          !commitAttempted &&
          !queryUncertain &&
          !closedAttempt &&
          !abort.signal.aborted
        ) {
          try {
            fresh();
            queryUncertain = true;
            const rollback = Promise.resolve(
              client.query(
                workspaceSelectionSql.rollback,
                [],
                Object.freeze({ deadlineMs: deadline, signal: abort.signal }),
              ),
            );
            void rollback.catch(() => {});
            await race(rollback);
            queryUncertain = false;
          } catch {
          } finally {
            try {
              fresh();
            } catch {}
          }
        }
        const released = dispose();
        if (released && !closedAttempt) {
          try {
            await race(released);
          } catch {
          } finally {
            try {
              fresh();
            } catch {}
          }
        }
        return held;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onCancel) signal?.removeEventListener("abort", onCancel);
        stop();
      }
    },
  });
}
