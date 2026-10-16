import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";
import type {
  StandaloneWorkspaceSqlClient,
  StandaloneWorkspaceSqlControl,
  StandaloneWorkspaceSqlPool,
} from "./standalone-workspace-bootstrap.js";

export const selfLogoutSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED",
  role: "SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,pg_catalog.pg_has_role(current_user,'morrow_identity_owner','MEMBER') AS owner_member,EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS role_member FROM pg_catalog.pg_roles r WHERE r.rolname=current_user",
  timeout: "SET LOCAL statement_timeout = '1s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '5s'",
  end: "SELECT outcome,audit_id FROM morrow_identity.end_self_browser_family($1,$2,$3,$4,$5,$6,$7,$8)",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
export type SelfLogoutOutcome = Readonly<{
  outcome: "ended" | "denied" | "unavailable" | "unknown";
}>;
const result = (outcome: SelfLogoutOutcome["outcome"]): SelfLogoutOutcome =>
  Object.freeze({ outcome });
const failure = () => Error("SELF_LOGOUT_CONTROL_UNAVAILABLE");
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const time = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
const names = [
  "commandId",
  "requestDigest",
  "configurationDigest",
  "environmentId",
  "applicationId",
  "clientId",
  "profileId",
  "sessionDigest",
] as const;
function closed(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).sort().join(",") !== [...keys].sort().join(",")) throw failure();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw failure();
    Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
  }
  return Object.freeze(copy);
}
function input(text: unknown) {
  // Reject raw objects/proxies without any reflection or property access.
  if (typeof text !== "string") throw failure();
  const v = closed(parseWorkosSessionStatusJson(text, 4096), ["schemaVersion", ...names]);
  if (
    v.schemaVersion !== 1 ||
    !uuid(v.commandId) ||
    !digest(v.requestDigest) ||
    !digest(v.configurationDigest) ||
    !digest(v.sessionDigest) ||
    !id(v.profileId) ||
    typeof v.environmentId !== "string" ||
    !/^environment_[A-Z0-9]{26}$/.test(v.environmentId) ||
    typeof v.applicationId !== "string" ||
    !/^app_[A-Z0-9]{26}$/.test(v.applicationId) ||
    typeof v.clientId !== "string" ||
    !/^client_[A-Z0-9]{26}$/.test(v.clientId)
  )
    throw failure();
  return Object.freeze(names.map((name) => v[name] as string));
}
function row(value: unknown) {
  const rows = closed(value, ["rows"]).rows;
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(rows);
  if (
    Object.getOwnPropertyDescriptor(rows, "length")?.value !== 1 ||
    Reflect.ownKeys(descriptors).sort().join(",") !== "0,length" ||
    !Object.hasOwn(descriptors["0"] ?? {}, "value")
  )
    throw failure();
  return descriptors["0"]!.value as unknown;
}
const roleKeys = [
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
function role(value: unknown) {
  const r = closed(row(value), roleKeys);
  if (
    r.role !== "morrow_identity_logout" ||
    r.login !== r.role ||
    roleKeys.slice(2).some((key) => r[key] !== false)
  )
    throw failure();
}
function decode(value: unknown): "ended" | "denied" {
  const r = closed(row(value), ["outcome", "audit_id"]);
  if (r.outcome === "ended" && uuid(r.audit_id)) return "ended";
  if (r.outcome === "denied" && r.audit_id === null) return "denied";
  throw failure();
}
export function createSelfLogoutControl({
  pool,
  now,
}: {
  pool: StandaloneWorkspaceSqlPool;
  now: () => number;
}) {
  let last = -1,
    invalidClock = false;
  const clock = () => {
    try {
      const at = now();
      if (invalidClock || !time(at) || at < last) throw failure();
      last = at;
      return at;
    } catch {
      invalidClock = true;
      throw failure();
    }
  };
  return Object.freeze({
    async end(
      text: unknown,
      external: StandaloneWorkspaceSqlControl,
      onInvoked?: () => void,
    ): Promise<SelfLogoutOutcome> {
      let values: readonly string[];
      try {
        values = input(text);
      } catch {
        return result("denied");
      }
      let invoked = false,
        stopped = false;
      let client: StandaloneWorkspaceSqlClient | undefined, disposal: Promise<void> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = new AbortController();
      let interrupt!: () => void;
      const interrupted = new Promise<{ interrupted: true }>((resolve) => {
        interrupt = () => resolve({ interrupted: true });
      });
      const dispose = () => {
        if (client && !disposal) {
          const owned = client;
          disposal = Promise.resolve().then(() => owned.release(true));
          void disposal.catch(() => {});
        }
        return disposal;
      };
      const stop = () => {
        stopped = true;
        abort.abort();
        interrupt();
        dispose();
      };
      let signal: AbortSignal | undefined;
      try {
        const started = clock();
        if (!external || !time(external.deadlineMs) || !(external.signal instanceof AbortSignal))
          throw failure();
        signal = external.signal;
        const deadline = Math.min(started + 5000, external.deadlineMs);
        const check = () => {
          if (stopped || signal!.aborted || clock() >= deadline) {
            stop();
            throw failure();
          }
        };
        const race = async <T>(pending: Promise<T>): Promise<T> => {
          void pending.catch(() => {});
          const answer = await Promise.race([pending.then((value) => ({ value })), interrupted]);
          if ("interrupted" in answer) throw failure();
          check();
          return answer.value;
        };
        const control = Object.freeze({ deadlineMs: deadline, signal: abort.signal });
        const query = async (
          statement: string,
          parameters: readonly string[] = Object.freeze([]),
        ) => {
          check();
          try {
            return await race(Promise.resolve(client!.query(statement, parameters, control)));
          } catch {
            stop();
            throw failure();
          }
        };
        check();
        signal.addEventListener("abort", stop, { once: true });
        timer = setTimeout(stop, Math.max(0, deadline - clock()));
        const connecting = Promise.resolve(pool.connect(control)).then((owned) => {
          client = owned;
          if (stopped || abort.signal.aborted) {
            dispose();
            throw failure();
          }
          return owned;
        });
        await race(connecting);
        await query(selfLogoutSql.begin);
        role(await query(selfLogoutSql.role));
        await query(selfLogoutSql.timeout);
        await query(selfLogoutSql.idleTimeout);
        check();
        // Latch BEFORE the source-owned notification and dispatch. Notification
        // never delays disposal or provides authority. No invalid hook is awaited.
        invoked = true;
        const notification: unknown = onInvoked?.();
        if (notification !== undefined) {
          try {
            Promise.prototype.then.call(
              notification,
              () => {},
              () => {},
            );
          } catch {}
          throw failure();
        }
        check();
        const answer = decode(await query(selfLogoutSql.end, values));
        if (answer === "denied") await query(selfLogoutSql.rollback);
        else await query(selfLogoutSql.commit);
        const pending = dispose();
        if (!pending) throw failure();
        await race(pending);
        check();
        return result(answer);
      } catch {
        const pending = dispose();
        if (pending && !stopped) {
          try {
            // Disposal cannot outlive the same attempt budget and yield success.
            await Promise.race([pending, interrupted]);
          } catch {}
        }
        return result(invoked ? "unknown" : "unavailable");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        stop();
      }
    },
  });
}
