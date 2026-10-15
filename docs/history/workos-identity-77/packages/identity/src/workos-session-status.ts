import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";

// A provider observation only. These handles issue no local identity, session,
// membership, grant or reusable permission. Active-list absence is not revoked.
export interface WorkosSessionPageControl {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
export type WorkosSessionPageReader = (
  selectorJson: string,
  control: Readonly<WorkosSessionPageControl>,
) => Promise<unknown>;
export interface WorkosSessionStatusDependencies {
  readonly readPage: WorkosSessionPageReader;
  readonly currentProfile: () => unknown;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}
export interface WorkosSessionObservation {
  readonly providerId: "workos";
  readonly environmentId: string;
  readonly expectedApplicationId: string;
  readonly expectedClientId: string;
  readonly clientBinding: "expected_only";
  readonly subjectId: string;
  readonly providerSessionId: string;
  readonly outcome: "observed_active" | "not_observed_active";
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly profileRevision: number;
  readonly profileDigest: string;
  readonly pageCount: number;
  readonly itemCount: number;
}
export type WorkosSessionStatusResult =
  | Readonly<{
      outcome: "observed_active" | "not_observed_active";
      handle: object;
    }>
  | Readonly<{ outcome: "held"; handle: null }>;

const encoder = new TextEncoder();
const held = Object.freeze({ outcome: "held" as const, handle: null });
const fail = () => Error("WORKOS_SESSION_STATUS_HELD");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const parsed = record(value);
  if (Object.keys(parsed).sort().join(",") !== [...keys].sort().join(",")) throw fail();
  return parsed;
}
const id = (value: unknown, prefix: string): value is string =>
  typeof value === "string" && new RegExp("^" + prefix + "_[A-Z0-9]{26}$").test(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const clockValue = (value: unknown): value is number => integer(value) && value <= 8640000000000000;
function time(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    throw fail();
  const at = Date.parse(value);
  const normalized = value.includes(".")
    ? value.slice(0, -1).padEnd(23, "0") + "Z"
    : value.slice(0, -1) + ".000Z";
  if (!clockValue(at) || new Date(at).toISOString() !== normalized) throw fail();
  return at;
}
function optionalText(value: unknown, max: number): void {
  if (value !== undefined && value !== null && (typeof value !== "string" || value.length > max))
    throw fail();
}
function session(value: unknown, subjectId: string, now: number) {
  const row = record(value);
  const required = [
    "object",
    "id",
    "user_id",
    "status",
    "expires_at",
    "ended_at",
    "created_at",
    "updated_at",
  ];
  const allowed = new Set([
    ...required,
    "impersonator",
    "ip_address",
    "organization_id",
    "user_agent",
    "auth_method",
  ]);
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !allowed.has(key))
  )
    throw fail();
  if (
    row.object !== "session" ||
    !id(row.id, "session") ||
    row.user_id !== subjectId ||
    row.status !== "active" ||
    row.ended_at !== null
  )
    throw fail();
  const expiresAt = time(row.expires_at);
  const createdAt = time(row.created_at);
  const updatedAt = time(row.updated_at);
  if (createdAt > updatedAt || updatedAt > now || createdAt >= expiresAt || expiresAt <= now)
    throw fail();
  optionalText(row.ip_address, 128);
  optionalText(row.user_agent, 4096);
  optionalText(row.auth_method, 128);
  if (
    row.organization_id !== undefined &&
    row.organization_id !== null &&
    !id(row.organization_id, "org")
  )
    throw fail();
  const impersonated = row.impersonator !== undefined && row.impersonator !== null;
  if (impersonated) {
    const impersonator = closed(row.impersonator, ["email", "reason"]);
    if (
      typeof impersonator.email !== "string" ||
      impersonator.email.length > 320 ||
      typeof impersonator.reason !== "string" ||
      impersonator.reason.length > 4096
    )
      throw fail();
  }
  return { id: row.id, expiresAt, impersonated };
}

export function createWorkosSessionStatusReader(
  profileJson: unknown,
  dependencies: WorkosSessionStatusDependencies,
) {
  let profile: Record<string, unknown>;
  try {
    profile = closed(parseWorkosSessionStatusJson(profileJson, 4096), [
      "schemaVersion",
      "providerId",
      "environmentId",
      "applicationId",
      "clientId",
      "revision",
    ]);
    if (
      profile.schemaVersion !== 1 ||
      profile.providerId !== "workos" ||
      !id(profile.environmentId, "environment") ||
      !id(profile.applicationId, "app") ||
      !id(profile.clientId, "client") ||
      !integer(profile.revision) ||
      profile.revision < 1 ||
      typeof dependencies.readPage !== "function" ||
      typeof dependencies.currentProfile !== "function" ||
      typeof dependencies.now !== "function"
    )
      throw fail();
  } catch {
    throw Error("WORKOS_SESSION_STATUS_CONFIG_INVALID");
  }
  const sourceProfile = profileJson as string;
  const readPage = dependencies.readPage;
  const currentProfile = dependencies.currentProfile;
  const now = dependencies.now;
  const externalSignal = dependencies.signal;
  const handles = new WeakMap<object, Readonly<WorkosSessionObservation>>();
  let previousTime = -1;
  let invalidated = false;
  function readClock(): number {
    try {
      if (invalidated) throw fail();
      const at: unknown = now();
      if (!clockValue(at) || at < previousTime) throw fail();
      previousTime = at;
      return at;
    } catch {
      invalidated = true;
      throw fail();
    }
  }
  function current(): number {
    try {
      readClock();
      const presentProfile: unknown = currentProfile();
      // Source/profile checks may perform synchronous I/O. Their elapsed time
      // cannot extend either the lookup deadline or an existing handle lease.
      const at = readClock();
      if (externalSignal?.aborted || presentProfile !== sourceProfile) throw fail();
      return at;
    } catch {
      // A reader owns one immutable configuration generation. Observed drift,
      // cancellation or a bad clock can never revive its previous handles.
      invalidated = true;
      throw fail();
    }
  }
  return Object.freeze({
    async observe(queryJson: unknown): Promise<WorkosSessionStatusResult> {
      let query: Record<string, unknown>;
      try {
        query = closed(parseWorkosSessionStatusJson(queryJson, 2048), [
          "schemaVersion",
          "subjectId",
          "providerSessionId",
        ]);
        if (
          query.schemaVersion !== 1 ||
          !id(query.subjectId, "user") ||
          !id(query.providerSessionId, "session")
        )
          throw fail();
      } catch {
        return held;
      }
      const subjectId = query.subjectId as string;
      const providerSessionId = query.providerSessionId as string;
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let live = true;
      const stop = () => abort.abort();
      try {
        const startedAt = readClock();
        const deadlineMs = startedAt + 10000;
        if (!clockValue(deadlineMs)) throw fail();
        const check = () => {
          const at = current();
          if (!live || abort.signal.aborted || at >= deadlineMs) throw fail();
          return at;
        };
        const checkedAt = check();
        externalSignal?.addEventListener("abort", stop, { once: true });
        const interrupted = new Promise<WorkosSessionStatusResult>((resolve) => {
          abort.signal.addEventListener("abort", () => resolve(held), { once: true });
          timer = setTimeout(() => abort.abort(), deadlineMs - checkedAt);
        });
        const operation = async (): Promise<WorkosSessionStatusResult> => {
          check();
          const digestBytes = await crypto.subtle.digest("SHA-256", encoder.encode(sourceProfile));
          check();
          const profileDigest = Array.from(new Uint8Array(digestBytes), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          let after: string | null = null;
          const cursors = new Set<string>();
          const sessions = new Set<string>();
          let totalBytes = 0;
          let itemCount = 0;
          let matchedExpiry: number | null = null;
          for (let pageCount = 1; pageCount <= 4; pageCount++) {
            check();
            const selector = JSON.stringify({
              schemaVersion: 1,
              subjectId,
              after,
              limit: 100,
              order: "asc",
            });
            const text = await readPage(
              selector,
              Object.freeze({ deadlineMs, signal: abort.signal }),
            );
            const at = check();
            const page = closed(parseWorkosSessionStatusJson(text, 131072), [
              "object",
              "data",
              "list_metadata",
            ]);
            totalBytes += encoder.encode(text as string).byteLength;
            if (
              totalBytes > 524288 ||
              page.object !== "list" ||
              !Array.isArray(page.data) ||
              page.data.length > 100
            )
              throw fail();
            const metadata = closed(page.list_metadata, ["before", "after"]);
            if (
              (metadata.before !== null && !id(metadata.before, "session")) ||
              (metadata.after !== null && !id(metadata.after, "session"))
            )
              throw fail();
            for (const value of page.data) {
              const entry = session(value, subjectId, at);
              if (sessions.has(entry.id)) throw fail();
              sessions.add(entry.id);
              itemCount++;
              if (entry.id === providerSessionId) {
                if (entry.impersonated) throw fail();
                matchedExpiry = entry.expiresAt;
              }
            }
            if (metadata.after === null) {
              const finishedAt = check();
              const expiresAtMs = Math.min(
                startedAt + 5000,
                matchedExpiry ?? Number.MAX_SAFE_INTEGER,
              );
              if (finishedAt >= expiresAtMs) throw fail();
              const outcome =
                matchedExpiry === null
                  ? ("not_observed_active" as const)
                  : ("observed_active" as const);
              const observation: Readonly<WorkosSessionObservation> = Object.freeze({
                providerId: "workos",
                environmentId: profile.environmentId as string,
                expectedApplicationId: profile.applicationId as string,
                expectedClientId: profile.clientId as string,
                clientBinding: "expected_only",
                subjectId,
                providerSessionId,
                outcome,
                observedAtMs: startedAt,
                expiresAtMs,
                profileRevision: profile.revision as number,
                profileDigest,
                pageCount,
                itemCount,
              });
              const handle = Object.freeze(Object.create(null)) as object;
              handles.set(handle, observation);
              return Object.freeze({ outcome, handle });
            }
            const next = metadata.after as string;
            if (page.data.length === 0 || cursors.has(next) || next === after || pageCount === 4)
              throw fail();
            cursors.add(next);
            after = next;
          }
          throw fail();
        };
        return await Promise.race([operation().catch(() => held), interrupted]);
      } catch {
        return held;
      } finally {
        live = false;
        abort.abort();
        if (timer !== undefined) clearTimeout(timer);
        externalSignal?.removeEventListener("abort", stop);
      }
    },
    readObservation(handle: unknown): Readonly<WorkosSessionObservation> | null {
      if (!handle || typeof handle !== "object") return null;
      const observation = handles.get(handle);
      if (!observation) return null;
      try {
        if (current() >= observation.expiresAtMs) return null;
        return observation;
      } catch {
        return null;
      }
    },
  });
}
