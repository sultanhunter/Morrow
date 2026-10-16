import { Client } from "@neondatabase/serverless";
import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";
import {
  controlledNeonHeld,
  ownRecord,
  wellFormed,
  controlledNeonLoginProfiles,
  controlledNeonMetadataSql,
  controlledNeonTuple,
  snapshotControlledNeonParameters,
  type ControlledNeonPoolName,
  type ControlledNeonProfile,
} from "./controlled-neon-login-profiles.js";
import {
  controlledNeonWorkspaceProfiles,
  snapshotControlledNeonWorkspaceParameters,
  type ControlledNeonWorkspacePoolName,
} from "./controlled-neon-workspace-profiles.js";
import {
  createControlledNeonSocketClass,
  type NeonSocketConstructor,
  type NeonOwnedSocket,
} from "./controlled-neon-transport.js";
import {
  assertManagedLoginRequestOwner,
  publishManagedLoginCleanup,
  type ManagedLoginRequestScope,
  type ManagedLoginRequestOwnerToken,
} from "./managed-login-request-scope.js";

type Control = Readonly<{ deadlineMs: number; signal: AbortSignal }>;
type Binding = Readonly<{
  schemaVersion: 1;
  environment: string;
  projectId: string;
  branchId: string;
  hostname: string;
  database: string;
}>;
type Lease = Readonly<{
  namespaceJson: string;
  password: string;
  expiresAtMs: number;
  revocationSignal: AbortSignal;
  release: (control: Control) => Promise<void>;
}>;
type Broker = { borrow(namespaceJson: string, control: Control): Promise<unknown> };
type OwnedRequest = Readonly<{
  scope: ManagedLoginRequestScope;
  ownerToken: ManagedLoginRequestOwnerToken;
  configurationDigest: string;
}>;
export type ControlledNeonLoginClient = Readonly<{
  query(
    text: string,
    values: readonly string[],
    control: Control,
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
  release(discard: boolean): Promise<void>;
}>;
export type ControlledNeonLoginPools = Readonly<
  Record<
    ControlledNeonPoolName,
    Readonly<{ connect(control: Control): Promise<ControlledNeonLoginClient> }>
  >
>;
export type ControlledNeonWorkspacePools = Readonly<
  Record<
    ControlledNeonWorkspacePoolName,
    Readonly<{ connect(control: Control): Promise<ControlledNeonLoginClient> }>
  >
>;
type Counters = Record<string, number>;
const metrics = new WeakMap<object, Record<ControlledNeonPoolName, Counters>>();
const workspaceMetrics = new WeakMap<object, Record<ControlledNeonWorkspacePoolName, Counters>>();
const time = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
function control(value: unknown): Control {
  const r = ownRecord(value, ["deadlineMs", "signal"]);
  if (!time(r.deadlineMs) || !(r.signal instanceof AbortSignal)) throw controlledNeonHeld();
  return Object.freeze({ deadlineMs: r.deadlineMs, signal: r.signal });
}
function binding(text: unknown): Binding {
  const r = ownRecord(parseWorkosSessionStatusJson(text, 4096), [
    "schemaVersion",
    "environment",
    "projectId",
    "branchId",
    "hostname",
    "database",
  ]);
  if (
    r.schemaVersion !== 1 ||
    !["development", "staging"].includes(r.environment as string) ||
    typeof r.projectId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,79}$/.test(r.projectId) ||
    typeof r.branchId !== "string" ||
    !/^br-[a-z0-9-]{1,77}$/.test(r.branchId) ||
    typeof r.hostname !== "string" ||
    r.hostname.length > 253 ||
    !/^ep-[a-z0-9-]+\.(?:c-[0-9]+\.)?[a-z0-9-]+\.(aws|azure)\.neon\.tech$/.test(r.hostname) ||
    r.hostname.split(".")[0]!.includes("-pooler") ||
    typeof r.database !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(r.database)
  )
    throw controlledNeonHeld();
  return Object.freeze(r) as Binding;
}
function ambient() {
  // Workers normally expose no such defaults. Node's test composition also
  // cannot inherit a PostgreSQL option, proxy or trust override.
  const p = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process;
  if (
    p?.env &&
    Object.keys(p.env).some((k) =>
      /^(PG|NEON_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(
        k,
      ),
    )
  )
    throw controlledNeonHeld();
}
function counters(): Counters {
  return Object.fromEntries(
    [
      "connectAttempts",
      "borrowAttempts",
      "leasesAcquired",
      "leaseReleaseAttempts",
      "leaseReleaseAcks",
      "leaseReleaseLateAcks",
      "cleanupLeaseReleaseAcks",
      "activeLeases",
      "primaryConnects",
      "primaryAttributions",
      "querySubmissions",
      "observerConnects",
      "observerReads",
      "primaryAbsenceVerified",
      "normalReleases",
      "heldClients",
      "unverifiedReleases",
      "socketAttempts",
      "socketsAcquired",
      "socketCloseAttempts",
      "socketCloseAcks",
      "lateSocketCloseAcks",
      "cleanupSocketCloseAcks",
      "framesSent",
      "framesReceived",
      "lateEvents",
      "activeWaitTimers",
      "activeWaitListeners",
    ].map((k) => [k, 0]),
  );
}
export function snapshotControlledNeonLoginPoolMetrics(pools: unknown) {
  const value = typeof pools === "object" && pools !== null ? metrics.get(pools) : undefined;
  if (!value) throw controlledNeonHeld();
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Object.freeze({ ...v })])),
  );
}
export function snapshotControlledNeonWorkspacePoolMetrics(pools: unknown) {
  const value =
    typeof pools === "object" && pools !== null ? workspaceMetrics.get(pools) : undefined;
  if (!value) throw controlledNeonHeld();
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Object.freeze({ ...v })])),
  );
}
function create(
  dependencies: unknown,
  synthetic: boolean,
  ownedRequest?: OwnedRequest,
  workspace?: false,
): Promise<ControlledNeonLoginPools>;
function create(
  dependencies: unknown,
  synthetic: false,
  ownedRequest: OwnedRequest,
  workspace: true,
): Promise<ControlledNeonWorkspacePools>;
async function create(
  dependencies: unknown,
  synthetic: boolean,
  ownedRequest?: OwnedRequest,
  workspace = false,
): Promise<ControlledNeonLoginPools | ControlledNeonWorkspacePools> {
  try {
    const parentControl = () =>
      ownedRequest
        ? assertManagedLoginRequestOwner(
            ownedRequest.scope,
            ownedRequest.ownerToken,
            ownedRequest.configurationDigest,
          )
        : undefined;
    parentControl();
    const d = ownRecord(
      dependencies,
      synthetic
        ? ["bindingJson", "credentialBroker", "now", "loopbackWsUrl"]
        : ["bindingJson", "credentialBroker", "now"],
    );
    const b = binding(d.bindingJson),
      brokerRecord = ownRecord(d.credentialBroker, ["borrow"]);
    if (
      typeof brokerRecord.borrow !== "function" ||
      typeof d.now !== "function" ||
      typeof globalThis.WebSocket !== "function"
    )
      throw controlledNeonHeld();
    ambient();
    const Native = globalThis.WebSocket as unknown as NeonSocketConstructor;
    const broker: Broker = {
      borrow: (namespaceJson, c) =>
        Reflect.apply(brokerRecord.borrow as Function, d.credentialBroker, [namespaceJson, c]),
    };
    const expectedUrl = `wss://${b.hostname}/v2?address=${b.hostname}:5432`;
    let targetUrl = expectedUrl;
    if (synthetic) {
      if (
        typeof d.loopbackWsUrl !== "string" ||
        !/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/morrow-neon-t88$/.test(d.loopbackWsUrl) ||
        new URL(d.loopbackWsUrl).port === "" ||
        Number(new URL(d.loopbackWsUrl).port) > 65535
      )
        throw controlledNeonHeld();
      targetUrl = d.loopbackWsUrl;
    }
    let last = -1,
      broken = false;
    const clock = () => {
      try {
        const at = Reflect.apply(d.now as Function, undefined, []);
        if (broken || !time(at) || at < last) throw controlledNeonHeld();
        last = at;
        return at;
      } catch {
        broken = true;
        throw controlledNeonHeld();
      }
    };
    clock();
    const runtimeNow = performance.now.bind(performance);
    const profiles = workspace ? controlledNeonWorkspaceProfiles : controlledNeonLoginProfiles;
    const all = Object.fromEntries(Object.keys(profiles).map((k) => [k, counters()])) as Record<
      ControlledNeonPoolName | ControlledNeonWorkspacePoolName,
      Counters
    >;
    const pools = Object.freeze(
      Object.fromEntries(
        Object.entries(profiles).map(([name, p]) => [
          name,
          Object.freeze({
            connect: (input: Control) =>
              connectOwned(
                p,
                input,
                all[name as ControlledNeonPoolName | ControlledNeonWorkspacePoolName],
              ),
          }),
        ]),
      ),
    ) as ControlledNeonLoginPools | ControlledNeonWorkspacePools;
    if (workspace) workspaceMetrics.set(pools, all);
    else metrics.set(pools, all);
    return pools;

    async function connectOwned(
      profile: ControlledNeonProfile,
      input: Control,
      m: Counters,
    ): Promise<ControlledNeonLoginClient> {
      // No connection, publication or borrowed handle exists for a request
      // already closed before this connect is admitted.
      try {
        parentControl();
      } catch {
        throw controlledNeonHeld();
      }
      const bump = (key: string) => {
        m[key] = (m[key] ?? 0) + 1;
      };
      bump("connectAttempts");
      let original: Control,
        D = 0,
        held = false,
        releasing = false,
        inFlight = false;
      let lease: Lease | undefined, rawRelease: ((c: Control) => Promise<void>) | undefined;
      let releasePromise: Promise<void> | undefined, leasePromise: Promise<void> | undefined;
      let C: number | undefined,
        cleanupAbort: AbortController | undefined,
        cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      let primary: Driver | undefined, observer: Driver | undefined;
      let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
      const lifetimeListeners: { signal: AbortSignal; listener: () => void }[] = [];
      type Driver = {
        client: Client;
        applicationName: string;
        socket?: NeonOwnedSocket;
        end?: Promise<void>;
      };
      const namespaceJson = JSON.stringify({
        schemaVersion: 1,
        providerId: "neon",
        environment: b.environment,
        projectId: b.projectId,
        branchId: b.branchId,
        hostname: b.hostname,
        database: b.database,
        role: profile.role,
        purpose: workspace
          ? "workspace_primary_and_one_same_role_observer"
          : "primary_and_one_same_role_observer",
      });
      const check = (deadline = D, signal?: AbortSignal) => {
        const parent = parentControl();
        if (parent) D = Math.min(D, parent.deadlineMs);
        const at = clock();
        if (
          held ||
          !original ||
          original.signal.aborted ||
          signal?.aborted ||
          lease?.revocationSignal.aborted ||
          at >= Math.min(deadline, D) ||
          (lease && at >= lease.expiresAtMs)
        )
          throw controlledNeonHeld();
        return at;
      };
      const live = () => {
        try {
          check();
          return true;
        } catch {
          return false;
        }
      };
      function watch(signal: AbortSignal) {
        signal.addEventListener("abort", poison, { once: true });
        lifetimeListeners.push({ signal, listener: poison });
        bump("activeWaitListeners");
      }
      function scheduleLifetime() {
        if (lifetimeTimer !== undefined) {
          clearTimeout(lifetimeTimer);
          m.activeWaitTimers!--;
        }
        lifetimeTimer = setTimeout(poison, Math.max(0, D - clock()));
        bump("activeWaitTimers");
      }
      const latch = () => {
        if (C !== undefined) return;
        C = runtimeNow() + 1000;
        cleanupAbort = new AbortController();
        cleanupTimer = setTimeout(() => cleanupAbort!.abort(), 1000);
      };
      function poison() {
        if (!held) {
          held = true;
          bump("heldClients");
        }
        const pending = release();
        void pending.catch(() => {});
      }
      async function wait<T>(pending: Promise<T>, deadline = D, signal?: AbortSignal): Promise<T> {
        // The operation already exists; the first authority check can itself
        // lose the request before any race handlers are attached.
        void pending.catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        const listeners: { signal: AbortSignal; listener: () => void }[] = [];
        try {
          const at = check(deadline, signal);
          deadline = Math.min(deadline, D);
          const stopped = new Promise<never>((_, reject) => {
            const abort = () => {
              poison();
              reject(controlledNeonHeld());
            };
            for (const s of new Set(
              [original.signal, signal, lease?.revocationSignal].filter(
                (v): v is AbortSignal => v !== undefined,
              ),
            )) {
              s.addEventListener("abort", abort, { once: true });
              listeners.push({ signal: s, listener: abort });
              bump("activeWaitListeners");
            }
            timer = setTimeout(abort, Math.max(0, deadline - at));
            bump("activeWaitTimers");
          });
          const answer = await Promise.race([pending, stopped]);
          check(deadline, signal);
          return answer;
        } catch {
          poison();
          throw controlledNeonHeld();
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer);
            m.activeWaitTimers!--;
          }
          for (const item of listeners) {
            item.signal.removeEventListener("abort", item.listener);
            m.activeWaitListeners!--;
          }
        }
      }
      async function cleanupWait(pending: Promise<unknown>) {
        const remaining = (C ?? runtimeNow()) - runtimeNow();
        void pending.catch(() => {});
        if (remaining <= 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            pending.catch(() => {}),
            new Promise<void>((r) => {
              timer = setTimeout(r, remaining);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      function cleanupControl(): Control {
        latch();
        // Normal authority may have ended before its last timestamp refreshed.
        // Map only the remaining original C using the existing trusted clock;
        // this disposal read neither checks nor renews business authority.
        let at = 0;
        try {
          at = clock();
        } catch {
          cleanupAbort!.abort();
        }
        const remaining = Math.max(0, (C ?? runtimeNow()) - runtimeNow());
        if (remaining <= 0) cleanupAbort!.abort();
        return Object.freeze({
          deadlineMs: Math.min(8640000000000000, at + Math.floor(remaining)),
          signal: cleanupAbort!.signal,
        });
      }
      function releaseLease(normal: boolean): Promise<void> {
        if (leasePromise) return leasePromise;
        if (!rawRelease) return Promise.resolve();
        bump("leaseReleaseAttempts");
        const c = normal
          ? Object.freeze({ deadlineMs: D, signal: original.signal })
          : cleanupControl();
        leasePromise = Promise.resolve()
          .then(() => rawRelease!(c))
          .then(() => {
            bump("leaseReleaseAcks");
            m.activeLeases!--;
            if (!live())
              bump(
                C !== undefined && runtimeNow() <= C
                  ? "cleanupLeaseReleaseAcks"
                  : "leaseReleaseLateAcks",
              );
          });
        void leasePromise.catch(() => {});
        return leasePromise;
      }
      function makeDriver(kind: "p" | "o"): Driver {
        check();
        ambient();
        const applicationName = `morrow_t88_${crypto.randomUUID().replaceAll("-", "")}_${kind}`;
        if (!/^morrow_t88_[a-f0-9]{32}_[po]$/.test(applicationName)) throw controlledNeonHeld();
        const driver = {} as Driver;
        driver.applicationName = applicationName;
        const Guard = createControlledNeonSocketClass({
          native: Native,
          expectedUrl,
          targetUrl,
          live,
          fault: poison,
          own: (s) => {
            driver.socket = s;
          },
          observe: (event) => {
            const key = {
              attempt: "socketAttempts",
              acquired: "socketsAcquired",
              closeAttempt: "socketCloseAttempts",
              closeAck: "socketCloseAcks",
              sent: "framesSent",
              received: "framesReceived",
              late: "lateEvents",
            }[event];
            bump(key);
            if (event === "closeAck" && !live())
              bump(
                C !== undefined && runtimeNow() <= C
                  ? "cleanupSocketCloseAcks"
                  : "lateSocketCloseAcks",
              );
          },
        });
        const remaining = Math.max(1, D - clock());
        driver.client = new Client({
          host: b.hostname,
          port: 5432,
          database: b.database,
          user: profile.role,
          password: lease!.password,
          ssl: false,
          connectionTimeoutMillis: remaining,
          query_timeout: 0,
          statement_timeout: profile.statementTimeout,
          idle_in_transaction_session_timeout: profile.idleTimeout,
          application_name: applicationName,
          options: "",
          client_encoding: "UTF8",
        });
        driver.client.neonConfig.useSecureWebSocket = true;
        driver.client.neonConfig.forceDisablePgSSL = true;
        driver.client.neonConfig.pipelineConnect = false;
        driver.client.neonConfig.coalesceWrites = false;
        driver.client.neonConfig.wsProxy = `${b.hostname}/v2`;
        driver.client.neonConfig.webSocketConstructor = Guard;
        driver.client.on("error", poison);
        return driver;
      }
      function end(driver: Driver): Promise<void> {
        if (!driver.end) {
          driver.end = Promise.resolve().then(() => driver.client.end());
          void driver.end.catch(() => {});
        }
        return driver.end;
      }
      async function closeNormal(driver: Driver) {
        check();
        await wait(end(driver));
        check();
        if (!driver.socket?.acquired()) throw controlledNeonHeld();
        await wait(driver.socket.closed);
        check();
        if (!driver.socket.isClosed()) throw controlledNeonHeld();
      }
      async function cleanup() {
        latch();
        const waits: Promise<unknown>[] = [];
        for (const driver of [primary, observer])
          if (driver) {
            driver.socket?.close();
            waits.push(end(driver));
            if (driver.socket?.acquired()) waits.push(driver.socket.closed);
          }
        waits.push(releaseLease(false));
        await cleanupWait(Promise.allSettled(waits));
      }
      function release(_discard = true): Promise<void> {
        if (releasePromise) return releasePromise;
        if (inFlight && !held) {
          held = true;
          bump("heldClients");
        }
        releasing = true;
        latch();
        releasePromise = Promise.resolve().then(async () => {
          try {
            if (held || !primary || !lease) throw controlledNeonHeld();
            check();
            await closeNormal(primary);
            check();
            observer = makeDriver("o");
            bump("observerConnects");
            await wait(observer.client.connect());
            check();
            bump("observerReads");
            const rows = await wait(
              observer.client.query(controlledNeonMetadataSql.observer, [
                tuple!.pid,
                tuple!.start,
                tuple!.database,
                tuple!.role,
                tuple!.applicationName,
              ]),
            );
            check();
            controlledNeonTuple(
              rows.rows,
              {
                role: profile.role,
                database: b.database,
                applicationName: observer.applicationName,
              },
              true,
            );
            bump("primaryAbsenceVerified");
            await closeNormal(observer);
            check();
            await wait(releaseLease(true));
            check();
            bump("normalReleases");
          } catch {
            if (!held) {
              held = true;
              bump("heldClients");
            }
            bump("unverifiedReleases");
            await cleanup();
            throw controlledNeonHeld();
          } finally {
            if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
            if (lifetimeTimer !== undefined) {
              clearTimeout(lifetimeTimer);
              lifetimeTimer = undefined;
              m.activeWaitTimers!--;
            }
            for (const item of lifetimeListeners) {
              item.signal.removeEventListener("abort", item.listener);
              m.activeWaitListeners!--;
            }
            lifetimeListeners.length = 0;
          }
        });
        void releasePromise.catch(() => {});
        if (ownedRequest) {
          try {
            publishManagedLoginCleanup(ownedRequest.scope, ownedRequest.ownerToken, releasePromise);
          } catch {
            // The normal branch is deferred; registration failure poisons it
            // synchronously without replacing or retrying the owned Promise.
            if (!held) {
              held = true;
              bump("heldClients");
            }
          }
        }
        return releasePromise;
      }
      let tuple: ReturnType<typeof controlledNeonTuple> | undefined;
      try {
        original = control(input);
        const parent = parentControl();
        if (parent) {
          const joined = new AbortController();
          const cancel = () => joined.abort();
          for (const signal of new Set([original.signal, parent.signal])) {
            signal.addEventListener("abort", cancel, { once: true });
            lifetimeListeners.push({ signal, listener: cancel });
            bump("activeWaitListeners");
            if (signal.aborted) cancel();
          }
          original = Object.freeze({
            deadlineMs: Math.min(original.deadlineMs, parent.deadlineMs),
            signal: joined.signal,
          });
        }
        const entry = clock();
        D = Math.min(original.deadlineMs, entry + 25000);
        check();
        watch(original.signal);
        scheduleLifetime();
        bump("borrowAttempts");
        const pending = Promise.resolve()
          .then(() => {
            check();
            return broker.borrow(
              namespaceJson,
              Object.freeze({ deadlineMs: D, signal: original.signal }),
            );
          })
          .then((value) => {
            if (value && typeof value === "object") {
              const desc = Object.getOwnPropertyDescriptor(value, "release");
              if (desc && "value" in desc && typeof desc.value === "function") {
                rawRelease = (c) => Reflect.apply(desc.value, value, [c]);
                bump("leasesAcquired");
                m.activeLeases!++;
              }
            }
            if (held) {
              void releaseLease(false).catch(() => {});
              throw controlledNeonHeld();
            }
            const r = ownRecord(value, [
              "namespaceJson",
              "password",
              "expiresAtMs",
              "revocationSignal",
              "release",
            ]);
            if (
              !rawRelease ||
              r.namespaceJson !== namespaceJson ||
              typeof r.password !== "string" ||
              r.password.length < 16 ||
              r.password.length > 1024 ||
              /[\x00-\x20\x7f]/.test(r.password) ||
              !wellFormed(r.password) ||
              !time(r.expiresAtMs) ||
              !(r.revocationSignal instanceof AbortSignal) ||
              typeof r.release !== "function"
            )
              throw controlledNeonHeld();
            lease = Object.freeze(r) as Lease;
            D = Math.min(D, lease.expiresAtMs);
            watch(lease.revocationSignal);
            check();
            scheduleLifetime();
            return lease;
          });
        await wait(pending);
        check();
        primary = makeDriver("p");
        bump("primaryConnects");
        await wait(primary.client.connect());
        check();
        const result = await wait(primary.client.query(controlledNeonMetadataSql.primary, []));
        check();
        tuple = controlledNeonTuple(result.rows, {
          role: profile.role,
          database: b.database,
          applicationName: primary.applicationName,
        });
        bump("primaryAttributions");
        return Object.freeze({
          async query(text: string, values: readonly string[], supplied: Control) {
            try {
              if (releasing || inFlight) throw controlledNeonHeld();
              const c = control(supplied),
                copied = workspace
                  ? snapshotControlledNeonWorkspaceParameters(profile, text, values)
                  : snapshotControlledNeonParameters(profile, text, values),
                deadline = Math.min(D, c.deadlineMs);
              check(deadline, c.signal);
              inFlight = true;
              bump("querySubmissions");
              const answer = await wait(
                Promise.resolve().then(() => {
                  check(deadline, c.signal);
                  return primary!.client.query(text, [...copied]);
                }),
                deadline,
                c.signal,
              );
              check(deadline, c.signal);
              return { rows: answer.rows as Record<string, unknown>[] };
            } catch {
              poison();
              throw controlledNeonHeld();
            } finally {
              inFlight = false;
            }
          },
          release,
        });
      } catch {
        poison();
        try {
          await release();
        } catch {
          // Keep the primary held failure; disposal failure is secondary.
        }
        throw controlledNeonHeld();
      }
    }
  } catch {
    throw controlledNeonHeld();
  }
}
export const createWorkersControlledNeonLoginPools = (dependencies: unknown) =>
  create(dependencies, false);
export const createSyntheticNodeControlledNeonLoginPools = (dependencies: unknown) =>
  create(dependencies, true);
export const createWorkersRequestBoundNeonLoginPools = (
  dependencies: unknown,
  scope: ManagedLoginRequestScope,
  expectedOwnerToken: ManagedLoginRequestOwnerToken,
  configurationDigest: string,
) =>
  create(
    dependencies,
    false,
    Object.freeze({ scope, ownerToken: expectedOwnerToken, configurationDigest }),
  );
export const createWorkersRequestBoundNeonWorkspacePools = (
  dependencies: unknown,
  scope: ManagedLoginRequestScope,
  expectedOwnerToken: ManagedLoginRequestOwnerToken,
  configurationDigest: string,
) =>
  create(
    dependencies,
    false,
    Object.freeze({ scope, ownerToken: expectedOwnerToken, configurationDigest }),
    true,
  );
