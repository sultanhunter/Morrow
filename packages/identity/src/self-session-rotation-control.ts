import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";
import { selfLogoutSql } from "./self-logout-control.js";
import type {
  StandaloneWorkspaceSqlClient,
  StandaloneWorkspaceSqlControl,
  StandaloneWorkspaceSqlPool,
} from "./standalone-workspace-bootstrap.js";

// Self rotation (P05.T01y, ADR-0004) on the logout executor and pool: the same transaction
// envelope and role check as self logout, and one fixed definer. Closed JSON input, fixed
// SQL, no retry. Once the rotate statement may have been sent, every loss is unknown.
export const selfRotationSql = Object.freeze({
  begin: selfLogoutSql.begin,
  role: selfLogoutSql.role,
  timeout: selfLogoutSql.timeout,
  idleTimeout: selfLogoutSql.idleTimeout,
  rotate:
    "SELECT outcome,idle_expires_at_ms,absolute_expires_at_ms FROM morrow_identity.rotate_self_browser_generation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
  commit: selfLogoutSql.commit,
  rollback: selfLogoutSql.rollback,
});
export type SelfRotationOutcome = Readonly<
  | { outcome: "rotated" | "current"; idleExpiresAtMs: number; absoluteExpiresAtMs: number }
  | { outcome: "reuse_revoked" | "denied" | "unavailable" | "unknown" }
>;
const failure = () => Error("SELF_ROTATION_CONTROL_UNAVAILABLE");
const plain = (outcome: "reuse_revoked" | "denied" | "unavailable" | "unknown") =>
  Object.freeze({ outcome }) as SelfRotationOutcome;
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const time = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
// Parameter order of rotate_self_browser_generation.
const names = [
  "commandId",
  "requestDigest",
  "configurationDigest",
  "environmentId",
  "applicationId",
  "clientId",
  "profileId",
  "presentedDigest",
  "newDigest",
  "newGenerationId",
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
  if (typeof text !== "string") throw failure();
  const v = closed(parseWorkosSessionStatusJson(text, 4096), ["schemaVersion", ...names]);
  if (
    v.schemaVersion !== 1 ||
    !uuid(v.commandId) ||
    !uuid(v.newGenerationId) ||
    v.commandId === v.newGenerationId ||
    !digest(v.requestDigest) ||
    !digest(v.configurationDigest) ||
    !digest(v.presentedDigest) ||
    !digest(v.newDigest) ||
    v.presentedDigest === v.newDigest ||
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
const instant = (v: unknown): number => {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,15}$/.test(v)) throw failure();
  const n = Number(v);
  if (!time(n)) throw failure();
  return n;
};
function decode(value: unknown): SelfRotationOutcome {
  const r = closed(row(value), ["outcome", "idle_expires_at_ms", "absolute_expires_at_ms"]);
  if (r.outcome === "rotated" || r.outcome === "current") {
    const idle = instant(r.idle_expires_at_ms),
      absolute = instant(r.absolute_expires_at_ms);
    if (idle > absolute) throw failure();
    return Object.freeze({
      outcome: r.outcome,
      idleExpiresAtMs: idle,
      absoluteExpiresAtMs: absolute,
    });
  }
  if (
    (r.outcome === "reuse_revoked" || r.outcome === "denied") &&
    r.idle_expires_at_ms === null &&
    r.absolute_expires_at_ms === null
  )
    return plain(r.outcome);
  throw failure();
}
export function createSelfRotationControl({
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
    async rotate(
      text: unknown,
      external: StandaloneWorkspaceSqlControl,
      onInvoked?: () => void,
    ): Promise<SelfRotationOutcome> {
      let values: readonly string[];
      try {
        values = input(text);
      } catch {
        return plain("denied");
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
        await query(selfRotationSql.begin);
        role(await query(selfRotationSql.role));
        await query(selfRotationSql.timeout);
        await query(selfRotationSql.idleTimeout);
        check();
        // Latch BEFORE the notification and the rotate statement. Notification grants no
        // authority and never delays disposal; an asynchronous hook is refused.
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
        const answer = decode(await query(selfRotationSql.rotate, values));
        // Only rotated and reuse_revoked wrote; current and denied wrote nothing.
        if (answer.outcome === "rotated" || answer.outcome === "reuse_revoked")
          await query(selfRotationSql.commit);
        else await query(selfRotationSql.rollback);
        const pending = dispose();
        if (!pending) throw failure();
        await race(pending);
        check();
        return answer;
      } catch {
        const pending = dispose();
        if (pending && !stopped) {
          try {
            await Promise.race([pending, interrupted]);
          } catch {}
        }
        return plain(invoked ? "unknown" : "unavailable");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        stop();
      }
    },
  });
}
