import { selfLogoutSql } from "../../packages/identity/src/self-logout-control.js";
import type { StandaloneWorkspaceSqlPool } from "../../packages/identity/src/standalone-workspace-bootstrap.js";

// Synthetic fixed-SQL oracle only. Actual role/SQL/locking is separately qualified
// by the PostgreSQL lab. This fixture never supplies a high-level permission port.
export const logoutFixtureOrigin = "https://workspace.example.test";
export const logoutFixtureConfiguration = Object.freeze({
  schemaVersion: 1,
  protocol: "morrow-local-self-logout-85",
  origin: logoutFixtureOrigin,
  providerId: "workos",
  environmentId: "environment_" + "A".repeat(26),
  applicationId: "app_" + "B".repeat(26),
  clientId: "client_" + "C".repeat(26),
  profileId: "profile_a",
});
export type LogoutFixtureStage =
  | "connect"
  | "begin"
  | "role"
  | "timeout"
  | "idleTimeout"
  | "end"
  | "commit"
  | "rollback"
  | "release";
export interface LogoutFixtureOptions {
  at?: number;
  roleUnsafe?: boolean;
  denied?: boolean;
  malformed?: boolean;
  stage?: (name: LogoutFixtureStage, fixture: LogoutFixture) => void | Promise<void>;
}
const hash = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
export type LogoutFixture = ReturnType<typeof createStandaloneLogoutFixture>;
export function createStandaloneLogoutFixture(options: LogoutFixtureOptions = {}) {
  let at = options.at ?? 1792100000000;
  const calls: { stage: LogoutFixtureStage; values: readonly string[] }[] = [];
  const families = new Map<string, { ended: boolean; audit: string }>();
  const metrics = {
    connections: 0,
    queryAttempts: 0,
    queryCompletions: 0,
    releaseAttempts: 0,
    releaseCompletions: 0,
    effects: 0,
    invocationCount: 0,
  };
  const evidence = {
    requestTranscript: true,
    configurationTranscript: true,
    textProof: true,
    controls: true,
  };
  const acceptedProofs = new Set<string>();
  let fixture!: {
    configurationJson: string;
    pool: StandaloneWorkspaceSqlPool;
    now: () => number;
    setTime: (value: number) => void;
    register: (secret: string) => Promise<void>;
    ended: (secret: string) => Promise<boolean>;
    calls: typeof calls;
    metrics: typeof metrics;
    evidence: typeof evidence;
  };
  const stage = async (name: LogoutFixtureStage, values: readonly string[] = []) => {
    calls.push({ stage: name, values: Object.freeze([...values]) });
    await options.stage?.(name, fixture);
  };
  const config = logoutFixtureConfiguration;
  const configDigest = hash(
    JSON.stringify([
      "morrow.browser.self_logout.configuration",
      "1",
      config.protocol,
      config.origin,
      "workos",
      config.environmentId,
      config.applicationId,
      config.clientId,
      config.profileId,
    ]),
  );
  const pool: StandaloneWorkspaceSqlPool = {
    async connect(control) {
      metrics.connections++;
      evidence.controls &&=
        control.signal instanceof AbortSignal && control.deadlineMs === at + 5000;
      await stage("connect");
      let closed = false,
        pending: string | undefined;
      return {
        async query(text, values, queryControl) {
          metrics.queryAttempts++;
          evidence.controls &&=
            queryControl.signal === control.signal &&
            queryControl.deadlineMs === control.deadlineMs;
          if (closed) throw Error("SYNTHETIC_CLOSED");
          const name = (Object.keys(selfLogoutSql) as (keyof typeof selfLogoutSql)[]).find(
            (key) => selfLogoutSql[key] === text,
          );
          if (!name) throw Error("SYNTHETIC_UNEXPECTED_SQL");
          let rows: Record<string, unknown>[] = [];
          if (name === "role")
            rows = [
              {
                role: "morrow_identity_logout",
                login: "morrow_identity_logout",
                rolsuper: options.roleUnsafe ?? false,
                rolbypassrls: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolreplication: false,
                rolinherit: false,
                owner_member: false,
                role_member: false,
              },
            ];
          if (name === "end") {
            metrics.invocationCount++;
            const [
              command,
              request,
              configuration,
              environment,
              application,
              client,
              profile,
              digest,
            ] = values;
            evidence.configurationTranscript &&= configuration === (await configDigest);
            evidence.requestTranscript &&=
              request ===
              (await hash(
                JSON.stringify([
                  "morrow.browser.self_logout",
                  "1",
                  command,
                  configuration,
                  "workos",
                  environment,
                  application,
                  client,
                  profile,
                  digest,
                ]),
              ));
            evidence.textProof &&= acceptedProofs.has(digest!);
            const allowed =
              !options.denied &&
              acceptedProofs.has(digest!) &&
              environment === config.environmentId &&
              application === config.applicationId &&
              client === config.clientId &&
              profile === config.profileId;
            const family = families.get(digest!);
            if (allowed && family) {
              pending = digest;
              rows = [{ outcome: "ended", audit_id: family.audit }];
            } else rows = [{ outcome: "denied", audit_id: null }];
            if (options.malformed) rows = [{ outcome: "ended", audit_id: "private-invalid-audit" }];
          }
          // Commit's durable effect occurs before its acknowledgement hook.
          if (name === "commit" && pending) {
            const family = families.get(pending)!;
            if (!family.ended) {
              family.ended = true;
              metrics.effects++;
            }
            pending = undefined;
          }
          if (name === "rollback") pending = undefined;
          await stage(name, values);
          metrics.queryCompletions++;
          return { rows };
        },
        async release(discard) {
          metrics.releaseAttempts++;
          if (discard !== true) throw Error("SYNTHETIC_NONDISCARD");
          closed = true;
          pending = undefined;
          await stage("release");
          metrics.releaseCompletions++;
        },
      };
    },
  };
  fixture = {
    configurationJson: JSON.stringify(config),
    pool,
    now: () => at,
    setTime: (value: number) => {
      at = value;
    },
    async register(secret: string) {
      const digest = await hash(secret);
      acceptedProofs.add(digest);
      if (!families.has(digest)) families.set(digest, { ended: false, audit: crypto.randomUUID() });
    },
    async ended(secret: string) {
      return families.get(await hash(secret))?.ended ?? false;
    },
    calls,
    metrics,
    evidence,
  };
  return fixture;
}
export function logoutFixtureRequest(
  options: {
    cookie?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array<ArrayBuffer>;
    method?: string;
    path?: string;
    signal?: AbortSignal;
  } = {},
) {
  const headers: Record<string, string> = {
    Origin: logoutFixtureOrigin,
    "Content-Type": "application/json",
    "X-Morrow-Request": "1",
    Cookie: options.cookie ?? "__Host-morrow_session=" + "A".repeat(43),
    ...options.headers,
  };
  const method = options.method ?? "POST";
  return new Request(logoutFixtureOrigin + (options.path ?? "/auth/logout"), {
    method,
    headers,
    signal: options.signal,
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: options.body ?? '{"schemaVersion":1}' }),
  });
}
