// Scripts-only operator laboratory. This port has no merchant or production authority.
import { createHash } from "node:crypto";

const operationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const anyUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const opaqueId = /^[A-Za-z0-9_-]{1,128}$/;
const providerId = /^[a-z][a-z0-9-]{0,31}$/;
const deny = (code: string): never => {
  throw Error(code);
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

// Closed, own-data JSON prevents getters, prototypes, cycles and exception content
// from becoming profile authority or escaping through a result/journal.
function data(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  if (depth > 12) return deny("SYNTHETIC_LAB_INPUT_DENIED");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) return deny("SYNTHETIC_LAB_INPUT_DENIED");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value))
    return deny("SYNTHETIC_LAB_INPUT_DENIED");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
    return deny("SYNTHETIC_LAB_INPUT_DENIED");
  const branch = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (value.length > 32 || Object.keys(descriptors).length !== value.length + 1)
      return deny("SYNTHETIC_LAB_INPUT_DENIED");
    return Object.freeze(
      Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          return deny("SYNTHETIC_LAB_INPUT_DENIED");
        return data(descriptor.value, depth + 1, branch);
      }),
    );
  }
  if (Object.keys(descriptors).length > 32) return deny("SYNTHETIC_LAB_INPUT_DENIED");
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable)
      return deny("SYNTHETIC_LAB_INPUT_DENIED");
    result[key] = data(descriptor.value, depth + 1, branch);
  }
  return Object.freeze(result);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}
function keys(value: unknown, expected: string[]) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",")
  );
}
function safeData(value: unknown, code: string) {
  try {
    return data(value);
  } catch {
    return deny(code);
  }
}

export type SyntheticLabProfile = {
  schemaVersion: 1;
  task: "P04.T01h";
  planSequence: 55 | 56 | 57 | 58 | 59;
  scope: "builtin_synthetic_operator";
  environment: "development";
  providerId: string;
  projectId: string;
  templateId: string;
  templateBuildId: string;
  cpu: number;
  memoryMiB: number;
  diskMiB: number;
  maximumWallMs: 600000;
  expectedCreditCeilingUsd: "0.25";
  outbound: "deny_all";
  merchantRouting: false;
};
export function compileSyntheticLabProfile(value: unknown) {
  const profile = safeData(value, "SYNTHETIC_LAB_PROFILE_DENIED") as SyntheticLabProfile;
  if (
    !keys(profile, [
      "schemaVersion",
      "task",
      "planSequence",
      "scope",
      "environment",
      "providerId",
      "projectId",
      "templateId",
      "templateBuildId",
      "cpu",
      "memoryMiB",
      "diskMiB",
      "maximumWallMs",
      "expectedCreditCeilingUsd",
      "outbound",
      "merchantRouting",
    ]) ||
    profile.schemaVersion !== 1 ||
    profile.task !== "P04.T01h" ||
    ![55, 56, 57, 58, 59].includes(profile.planSequence) ||
    profile.scope !== "builtin_synthetic_operator" ||
    profile.environment !== "development" ||
    typeof profile.providerId !== "string" ||
    !providerId.test(profile.providerId) ||
    typeof profile.projectId !== "string" ||
    !anyUuid.test(profile.projectId) ||
    typeof profile.templateId !== "string" ||
    !opaqueId.test(profile.templateId) ||
    typeof profile.templateBuildId !== "string" ||
    !anyUuid.test(profile.templateBuildId) ||
    !Number.isSafeInteger(profile.cpu) ||
    profile.cpu < 1 ||
    profile.cpu > 2 ||
    !Number.isSafeInteger(profile.memoryMiB) ||
    profile.memoryMiB < 1 ||
    profile.memoryMiB > 4096 ||
    !Number.isSafeInteger(profile.diskMiB) ||
    profile.diskMiB < 1 ||
    profile.diskMiB > 10240 ||
    profile.maximumWallMs !== 600000 ||
    profile.expectedCreditCeilingUsd !== "0.25" ||
    profile.outbound !== "deny_all" ||
    profile.merchantRouting !== false
  )
    return deny("SYNTHETIC_LAB_PROFILE_DENIED");
  return Object.freeze({
    profile,
    profileSha256: sha(canonical(profile)),
    providerCalls: false,
    merchantDispatch: false,
    productionQualification: false,
  } as const);
}
export type SyntheticLabOperation = {
  operationId: string;
  profileSha256: string;
  sourceSha256: string;
  startedAtMs: number;
  deadlineMs: number;
  metadata: Readonly<Record<string, string>>;
  markerPath: string;
  markerValue: string;
};
export function prepareSyntheticLabOperation(
  profile: unknown,
  operationId: string,
  startedAtMs: number,
  sourceSha256: string,
): SyntheticLabOperation {
  const compiled = compileSyntheticLabProfile(profile);
  if (
    typeof operationId !== "string" ||
    !operationUuid.test(operationId) ||
    typeof sourceSha256 !== "string" ||
    !digest.test(sourceSha256) ||
    !Number.isSafeInteger(startedAtMs) ||
    startedAtMs < 0 ||
    !Number.isSafeInteger(startedAtMs + compiled.profile.maximumWallMs)
  )
    return deny("SYNTHETIC_LAB_OPERATION_DENIED");
  const deadlineMs = startedAtMs + compiled.profile.maximumWallMs;
  return Object.freeze({
    operationId,
    profileSha256: compiled.profileSha256,
    sourceSha256,
    startedAtMs,
    deadlineMs,
    metadata: Object.freeze({
      morrowLab: "P04.T01h",
      morrowOperation: operationId,
      morrowProfile: compiled.profileSha256,
      morrowSource: sourceSha256,
      morrowStarted: String(startedAtMs),
      morrowDeadline: String(deadlineMs),
    }),
    markerPath: `/tmp/morrow-synthetic-${operationId}.txt`,
    markerValue: `MORROW_SYNTHETIC_PERSISTENCE_V1:${operationId}\n`,
  });
}
export type SyntheticLabResource = {
  id: string;
  metadata: Readonly<Record<string, string>>;
  templateId: string;
  cpu: number;
  memoryMiB: number;
  state: "running" | "paused";
  network: { outbound: "deny_all" | "unknown"; controllerAuth: boolean };
  lifecycle: {
    onTimeout: "kill" | "unknown";
    autoResume: boolean;
    createdAtMs: number;
    endAtMs: number | null;
  };
};
export type SyntheticLabContext = { deadlineMs: number; signal: AbortSignal };
export type SyntheticLabCreate = { profile: SyntheticLabProfile; operation: SyntheticLabOperation };
export type SyntheticLabLookup = { resources: SyntheticLabResource[]; complete: boolean };
export interface SyntheticLabPort {
  create(spec: SyntheticLabCreate, context: SyntheticLabContext): Promise<SyntheticLabResource>;
  getByOperation(
    operation: SyntheticLabOperation,
    context: SyntheticLabContext,
  ): Promise<SyntheticLabLookup>;
  inspect(id: string, context: SyntheticLabContext): Promise<SyntheticLabResource | null>;
  writeMarker(id: string, path: string, value: string, context: SyntheticLabContext): Promise<void>;
  readMarker(id: string, path: string, context: SyntheticLabContext): Promise<string>;
  pause(id: string, context: SyntheticLabContext): Promise<void>;
  restore(id: string, context: SyntheticLabContext): Promise<void>;
  kill(id: string, context: SyntheticLabContext): Promise<void>;
}
export type SyntheticLabPhase =
  | "prepared"
  | "create_requested"
  | "created"
  | "marker_requested"
  | "pause_requested"
  | "paused"
  | "restore_requested"
  | "checking"
  | "cleanup_requested"
  | "deleted"
  | "unresolved";
export type SyntheticLabRecord = {
  operation: SyntheticLabOperation;
  createAttempted: boolean;
  sandboxId: string | null;
  phase: SyntheticLabPhase;
};
export type SyntheticLabOptions = {
  startedAtMs: number;
  sourceSha256: string;
  now?: () => number;
  signal?: AbortSignal;
  resume?: SyntheticLabRecord;
  cleanupOnly?: boolean;
  persist(record: SyntheticLabRecord): Promise<void>;
};
export type SyntheticLabResult = {
  status: "passed" | "failed" | "unresolved";
  code: string;
  cleanup: "not_needed" | "verified_deleted" | "unresolved" | "foreign_resource_denied";
  deletionObservation: "not_observed" | "absent";
  record: SyntheticLabRecord;
  productionQualified: false;
  memoryPersistenceClaimed: false;
};
const phases: SyntheticLabPhase[] = [
  "prepared",
  "create_requested",
  "created",
  "marker_requested",
  "pause_requested",
  "paused",
  "restore_requested",
  "checking",
  "cleanup_requested",
  "deleted",
  "unresolved",
];
function owned(
  value: unknown,
  operation: SyntheticLabOperation,
  id?: string,
): value is SyntheticLabResource {
  try {
    const resource = safeData(value, "SYNTHETIC_LAB_IDENTITY_DENIED") as SyntheticLabResource;
    return (
      !!resource &&
      typeof resource.id === "string" &&
      opaqueId.test(resource.id) &&
      (id === undefined || resource.id === id) &&
      canonical(resource.metadata) === canonical(operation.metadata)
    );
  } catch {
    return false;
  }
}
function matchesProfile(
  resource: SyntheticLabResource,
  profile: SyntheticLabProfile,
  operation: SyntheticLabOperation,
  expectedState: "running" | "paused",
  nowMs: number,
) {
  return (
    keys(resource, [
      "id",
      "metadata",
      "templateId",
      "cpu",
      "memoryMiB",
      "state",
      "network",
      "lifecycle",
    ]) &&
    keys(resource.network, ["outbound", "controllerAuth"]) &&
    keys(resource.lifecycle, ["onTimeout", "autoResume", "createdAtMs", "endAtMs"]) &&
    resource.templateId === profile.templateId &&
    resource.cpu === profile.cpu &&
    resource.memoryMiB === profile.memoryMiB &&
    resource.state === expectedState &&
    resource.network.outbound === "deny_all" &&
    resource.network.controllerAuth === true &&
    resource.lifecycle.onTimeout === "kill" &&
    resource.lifecycle.autoResume === false &&
    Number.isSafeInteger(resource.lifecycle.createdAtMs) &&
    resource.lifecycle.createdAtMs >= operation.startedAtMs &&
    resource.lifecycle.createdAtMs <= nowMs &&
    (expectedState === "paused"
      ? resource.lifecycle.endAtMs === null
      : Number.isSafeInteger(resource.lifecycle.endAtMs) &&
        resource.lifecycle.endAtMs !== null &&
        resource.lifecycle.endAtMs > nowMs &&
        resource.lifecycle.endAtMs <= operation.deadlineMs)
  );
}
function publicCode(error: unknown) {
  let message = "";
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor && "value" in descriptor && typeof descriptor.value === "string")
      message = descriptor.value;
  } catch {
    /* Exception getters/proxies never escape the report. */
  }
  return new Set([
    "SYNTHETIC_LAB_CANCELLED",
    "SYNTHETIC_LAB_DEADLINE",
    "SYNTHETIC_LAB_IDENTITY_DENIED",
    "SYNTHETIC_LAB_PROFILE_DENIED",
    "SYNTHETIC_LAB_MARKER_DENIED",
    "SYNTHETIC_LAB_PERSISTENCE_DENIED",
    "SYNTHETIC_LAB_CREATE_UNRESOLVED",
    "SYNTHETIC_LAB_LOOKUP_UNRESOLVED",
    "SYNTHETIC_LAB_CLEANUP_ONLY",
    "SYNTHETIC_LAB_JOURNAL_FAILED",
  ]).has(message)
    ? message
    : "SYNTHETIC_LAB_PROVIDER_FAILED";
}

export async function runSyntheticLab(
  configuration: unknown,
  operationId: string,
  port: SyntheticLabPort,
  options: SyntheticLabOptions,
): Promise<SyntheticLabResult> {
  const { profile } = compileSyntheticLabProfile(configuration);
  const operation = prepareSyntheticLabOperation(
    profile,
    operationId,
    options.startedAtMs,
    options.sourceSha256,
  );
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const persist = options.persist;
  if (
    typeof persist !== "function" ||
    (options.cleanupOnly !== undefined && typeof options.cleanupOnly !== "boolean") ||
    (options.cleanupOnly === true && !options.resume) ||
    (options.resume && options.cleanupOnly !== true)
  )
    return deny("SYNTHETIC_LAB_RESUME_DENIED");
  const cleanupOnly = options.cleanupOnly === true;
  let record: SyntheticLabRecord = {
    operation,
    createAttempted: false,
    sandboxId: null,
    phase: "prepared",
  };
  if (options.resume) {
    const resume = safeData(options.resume, "SYNTHETIC_LAB_RESUME_DENIED") as SyntheticLabRecord;
    if (
      !keys(resume, ["operation", "createAttempted", "sandboxId", "phase"]) ||
      canonical(resume.operation) !== canonical(operation) ||
      !phases.includes(resume.phase) ||
      typeof resume.createAttempted !== "boolean" ||
      (resume.sandboxId !== null &&
        (typeof resume.sandboxId !== "string" || !opaqueId.test(resume.sandboxId))) ||
      (resume.phase !== "prepared" && !resume.createAttempted) ||
      (resume.sandboxId !== null && !resume.createAttempted) ||
      ([
        "created",
        "marker_requested",
        "pause_requested",
        "paused",
        "restore_requested",
        "checking",
        "cleanup_requested",
        "deleted",
      ].includes(resume.phase) &&
        resume.sandboxId === null)
    )
      return deny("SYNTHETIC_LAB_RESUME_DENIED");
    record = { ...resume, operation };
  }
  let possibleEffect = record.createAttempted;
  let checksPassed = false;
  let code = "SYNTHETIC_LAB_FAILED";
  let cleanup: SyntheticLabResult["cleanup"] = "not_needed";
  let deletionObservation: SyntheticLabResult["deletionObservation"] = "not_observed";
  let journalFailed = false;
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < operation.startedAtMs)
      return deny("SYNTHETIC_LAB_DEADLINE");
    return value;
  };
  const checkpoint = () => {
    if (signal?.aborted) return deny("SYNTHETIC_LAB_CANCELLED");
    if (clock() >= operation.deadlineMs) return deny("SYNTHETIC_LAB_DEADLINE");
  };
  const journal = async (phase: SyntheticLabPhase) => {
    record = { ...record, phase };
    try {
      await persist(safeData(record, "SYNTHETIC_LAB_JOURNAL_FAILED") as SyntheticLabRecord);
    } catch {
      journalFailed = true;
      return deny("SYNTHETIC_LAB_JOURNAL_FAILED");
    }
  };
  let cleanupDeadlineMs: number | undefined;
  const call = async <T>(
    fn: (context: SyntheticLabContext) => Promise<T>,
    cleanupCall = false,
  ): Promise<T> => {
    if (!cleanupCall) checkpoint();
    const current = clock();
    if (cleanupCall && cleanupDeadlineMs === undefined) {
      if (!Number.isSafeInteger(current + 150000)) return deny("SYNTHETIC_LAB_DEADLINE");
      cleanupDeadlineMs = current + 150000;
    }
    const deadlineMs = Math.min(
      current + 30000,
      cleanupCall ? cleanupDeadlineMs! : operation.deadlineMs,
    );
    const remaining = deadlineMs - current;
    if (remaining <= 0) return deny("SYNTHETIC_LAB_DEADLINE");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fn({ deadlineMs, signal: controller.signal })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error("SYNTHETIC_LAB_DEADLINE"));
          }, remaining);
          if (!cleanupCall && signal) {
            listener = () => {
              controller.abort();
              reject(Error("SYNTHETIC_LAB_CANCELLED"));
            };
            signal.addEventListener("abort", listener, { once: true });
            if (signal.aborted) listener();
          }
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (listener) signal?.removeEventListener("abort", listener);
    }
  };
  const lookup = async (cleanupCall = false) => {
    const observed = safeData(
      await call((context) => port.getByOperation(operation, context), cleanupCall),
      "SYNTHETIC_LAB_LOOKUP_UNRESOLVED",
    ) as SyntheticLabLookup;
    if (
      !keys(observed, ["resources", "complete"]) ||
      observed.complete !== true ||
      !Array.isArray(observed.resources) ||
      observed.resources.length > 1
    ) {
      // Matching/incomplete metadata can describe an already-existing effect,
      // even when this controller did not observe its original create.
      possibleEffect = true;
      record = { ...record, createAttempted: true };
      return deny("SYNTHETIC_LAB_LOOKUP_UNRESOLVED");
    }
    return observed.resources[0] ?? null;
  };
  const checked = async (expectedState: "running" | "paused") => {
    const observed = safeData(
      await call((context) => port.inspect(record.sandboxId!, context)),
      "SYNTHETIC_LAB_IDENTITY_DENIED",
    ) as SyntheticLabResource | null;
    if (!owned(observed, operation, record.sandboxId!))
      return deny("SYNTHETIC_LAB_IDENTITY_DENIED");
    if (!matchesProfile(observed, profile, operation, expectedState, clock()))
      return deny("SYNTHETIC_LAB_PROFILE_DENIED");
  };
  try {
    await journal(record.phase);
    if (cleanupOnly) return deny("SYNTHETIC_LAB_CLEANUP_ONLY");
    checkpoint();
    const existing = await lookup();
    let candidateId: string;
    if (existing) {
      if (!owned(existing, operation)) {
        cleanup = "foreign_resource_denied";
        return deny("SYNTHETIC_LAB_IDENTITY_DENIED");
      }
      possibleEffect = true;
      record = { ...record, createAttempted: true };
      candidateId = existing.id;
    } else {
      record = { ...record, createAttempted: true };
      await journal("create_requested");
      possibleEffect = true;
      const created = safeData(
        await call((context) => port.create({ profile, operation }, context)),
        "SYNTHETIC_LAB_IDENTITY_DENIED",
      );
      if (!owned(created, operation)) return deny("SYNTHETIC_LAB_IDENTITY_DENIED");
      candidateId = created.id;
    }
    // A create/list response is not enough to establish a known resource. A
    // static identity read must confirm its claimed ID before null inspection
    // of that ID can ever count as terminal absence of the original effect.
    const confirmed = safeData(
      await call((context) => port.inspect(candidateId, context)),
      "SYNTHETIC_LAB_IDENTITY_DENIED",
    );
    if (!owned(confirmed, operation, candidateId)) return deny("SYNTHETIC_LAB_IDENTITY_DENIED");
    record = { ...record, sandboxId: candidateId };
    await journal("created");
    await checked("running");
    await journal("marker_requested");
    await call((context) =>
      port.writeMarker(record.sandboxId!, operation.markerPath, operation.markerValue, context),
    );
    if (
      (await call((context) =>
        port.readMarker(record.sandboxId!, operation.markerPath, context),
      )) !== operation.markerValue
    )
      return deny("SYNTHETIC_LAB_MARKER_DENIED");
    await journal("pause_requested");
    await call((context) => port.pause(record.sandboxId!, context));
    await checked("paused");
    await journal("paused");
    await journal("restore_requested");
    await call((context) => port.restore(record.sandboxId!, context));
    await checked("running");
    await journal("checking");
    if (
      (await call((context) =>
        port.readMarker(record.sandboxId!, operation.markerPath, context),
      )) !== operation.markerValue
    )
      return deny("SYNTHETIC_LAB_PERSISTENCE_DENIED");
    checkpoint();
    checksPassed = true;
    code = "SYNTHETIC_LAB_CHECKS_PASSED";
  } catch (error) {
    code = publicCode(error);
  }
  // Cleanup ignores the caller's cancelled/expired execution scope, but has its
  // own finite scope. Inspection and deletion must never restore a paused guest.
  if (possibleEffect && cleanup !== "foreign_resource_denied") {
    try {
      let current: SyntheticLabResource | null;
      if (record.sandboxId === null) {
        const recovered = await lookup(true);
        if (!recovered) return deny("SYNTHETIC_LAB_CREATE_UNRESOLVED");
        if (!owned(recovered, operation)) {
          cleanup = "foreign_resource_denied";
          return deny("SYNTHETIC_LAB_IDENTITY_DENIED");
        }
        current = safeData(
          await call((context) => port.inspect(recovered.id, context), true),
          "SYNTHETIC_LAB_IDENTITY_DENIED",
        ) as SyntheticLabResource | null;
        // An unconfirmed listing ID cannot turn its absence into proof that
        // the original unknown create had no effect at another resource ID.
        if (current === null) return deny("SYNTHETIC_LAB_CREATE_UNRESOLVED");
        if (!owned(current, operation, recovered.id)) {
          cleanup = "foreign_resource_denied";
          return deny("SYNTHETIC_LAB_IDENTITY_DENIED");
        }
        record = { ...record, sandboxId: recovered.id };
      } else
        current = safeData(
          await call((context) => port.inspect(record.sandboxId!, context), true),
          "SYNTHETIC_LAB_IDENTITY_DENIED",
        ) as SyntheticLabResource | null;
      if (current === null) {
        cleanup = "verified_deleted";
        deletionObservation = "absent";
      } else if (!owned(current, operation, record.sandboxId!)) cleanup = "foreign_resource_denied";
      else {
        await journal("cleanup_requested");
        try {
          await call((context) => port.kill(record.sandboxId!, context), true);
        } catch {
          /* An uncertain kill still needs terminal inspection. */
        }
        const terminal = safeData(
          await call((context) => port.inspect(record.sandboxId!, context), true),
          "SYNTHETIC_LAB_IDENTITY_DENIED",
        ) as SyntheticLabResource | null;
        if (terminal === null) {
          cleanup = "verified_deleted";
          deletionObservation = "absent";
        } else
          cleanup = owned(terminal, operation, record.sandboxId!)
            ? "unresolved"
            : "foreign_resource_denied";
      }
    } catch (error) {
      if (cleanup !== "foreign_resource_denied") cleanup = "unresolved";
      if (publicCode(error) === "SYNTHETIC_LAB_CREATE_UNRESOLVED")
        code = "SYNTHETIC_LAB_CREATE_UNRESOLVED";
    }
  }
  let status: SyntheticLabResult["status"] =
    checksPassed && cleanup === "verified_deleted"
      ? "passed"
      : cleanup === "unresolved" || cleanup === "foreign_resource_denied" || journalFailed
        ? "unresolved"
        : "failed";
  try {
    await journal(
      cleanup === "verified_deleted"
        ? "deleted"
        : possibleEffect || cleanup === "foreign_resource_denied"
          ? "unresolved"
          : "prepared",
    );
  } catch {
    status = "unresolved";
    code = "SYNTHETIC_LAB_JOURNAL_FAILED";
  }
  if (journalFailed) {
    status = "unresolved";
    code = "SYNTHETIC_LAB_JOURNAL_FAILED";
  }
  return {
    status,
    code,
    cleanup,
    deletionObservation,
    record: safeData(record, "SYNTHETIC_LAB_JOURNAL_FAILED") as SyntheticLabRecord,
    productionQualified: false,
    memoryPersistenceClaimed: false,
  };
}
