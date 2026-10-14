// Scripts-only synthetic operator laboratory. No merchant runtime or provider credentials.
import { createHash } from "node:crypto";

const organizationId = "8862ff17-6109-4eb1-ac70-2f7bafba64ae";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    if (["undefined", "function", "symbol", "bigint"].includes(typeof value))
      throw Error("DEVELOPMENT_LAB_CONFIGURATION_DENIED");
    if (typeof value === "number" && !Number.isFinite(value))
      throw Error("DEVELOPMENT_LAB_CONFIGURATION_DENIED");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function developmentLabConfiguration(planSequence = 53) {
  if (planSequence !== 53) throw Error("DEVELOPMENT_LAB_PLAN_DENIED");
  return {
    schemaVersion: 1,
    task: "P04.T01f",
    planSequence,
    environment: "development",
    scope: "built_in_synthetic_operator_lab_only",
    organizationId,
    region: "us",
    sandboxClass: "container",
    snapshot: "daytona-small",
    cpu: 1,
    memoryGiB: 1,
    diskGiB: 3,
    maximumContainers: 1,
    maximumWallSeconds: 600,
    autoStopMinutes: 5,
    autoDeleteMinutes: 1,
    estimatedCreditCeilingUsd: "0.25",
    networkPolicy: "requested_block_all_with_tier1_essential_service_exceptions",
    publicPreview: false,
    merchantRouting: false,
    productionQualified: false,
    fixture: "synthetic_file_persistence_v1",
  };
}
export type DevelopmentLabConfiguration = ReturnType<typeof developmentLabConfiguration>;
export function compileDevelopmentLabConfiguration(value: unknown) {
  try {
    const expected = developmentLabConfiguration();
    if (canonical(value) !== canonical(expected))
      throw Error("DEVELOPMENT_LAB_CONFIGURATION_DENIED");
    return {
      configuration: Object.freeze(expected),
      profileSha256: sha(canonical(expected)),
      providerCalls: false,
      merchantDispatch: false,
      productionQualification: false,
    } as const;
  } catch {
    throw Error("DEVELOPMENT_LAB_CONFIGURATION_DENIED");
  }
}

export type DevelopmentLabOperation = {
  operationId: string;
  name: string;
  labels: Readonly<Record<string, string>>;
  profileSha256: string;
  startedAtMs: number;
  deadlineMs: number;
  markerPath: string;
  markerValue: string;
};
export function prepareDevelopmentLabOperation(
  config: unknown,
  operationId: string,
  startedAtMs: number,
): DevelopmentLabOperation {
  const compiled = compileDevelopmentLabConfiguration(config);
  if (!uuid.test(operationId) || !Number.isSafeInteger(startedAtMs) || startedAtMs < 0)
    throw Error("DEVELOPMENT_LAB_OPERATION_DENIED");
  const deadlineMs = startedAtMs + 600_000;
  if (!Number.isSafeInteger(deadlineMs)) throw Error("DEVELOPMENT_LAB_OPERATION_DENIED");
  return Object.freeze({
    operationId,
    name: `morrow-dev-lab-${operationId}`,
    labels: Object.freeze({
      morrowLab: "P04.T01f",
      morrowOperation: operationId,
      morrowProfile: compiled.profileSha256,
      morrowDeadline: String(deadlineMs),
    }),
    profileSha256: compiled.profileSha256,
    startedAtMs,
    deadlineMs,
    markerPath: `/tmp/morrow-dev-lab-${operationId}.txt`,
    markerValue: `MORROW_SYNTHETIC_PERSISTENCE_V1:${operationId}\n`,
  });
}

export type DevelopmentLabSandbox = {
  id: string;
  name: string;
  labels: Record<string, string>;
  sandboxClass: string;
  snapshot: string;
  cpu: number;
  memoryGiB: number;
  diskGiB: number;
  state: string;
};
export type DevelopmentLabContext = { deadlineMs: number; signal: AbortSignal };
export type DevelopmentLabCreate = {
  name: string;
  labels: Readonly<Record<string, string>>;
  organizationId: string;
  region: "us";
  sandboxClass: "container";
  snapshot: "daytona-small";
  cpu: 1;
  memoryGiB: 1;
  diskGiB: 3;
  autoStopMinutes: 5;
  autoDeleteMinutes: 1;
  networkBlockAll: true;
  publicPreview: false;
};
export interface DevelopmentLabPort {
  create(
    spec: DevelopmentLabCreate,
    context: DevelopmentLabContext,
  ): Promise<DevelopmentLabSandbox>;
  getByName(name: string, context: DevelopmentLabContext): Promise<DevelopmentLabSandbox | null>;
  inspect(id: string, context: DevelopmentLabContext): Promise<DevelopmentLabSandbox | null>;
  writeMarker(
    id: string,
    path: string,
    value: string,
    context: DevelopmentLabContext,
  ): Promise<void>;
  readMarker(id: string, path: string, context: DevelopmentLabContext): Promise<string>;
  stop(id: string, context: DevelopmentLabContext): Promise<void>;
  start(id: string, context: DevelopmentLabContext): Promise<void>;
  delete(id: string, context: DevelopmentLabContext): Promise<void>;
}
export type DevelopmentLabRecord = {
  operation: DevelopmentLabOperation;
  createAttempted: boolean;
  sandboxId: string | null;
  phase:
    | "prepared"
    | "create_requested"
    | "created"
    | "checking"
    | "cleanup_requested"
    | "deleted"
    | "unresolved";
};
export type DevelopmentLabResult = {
  status: "passed" | "failed" | "unresolved";
  code: string;
  cleanup: "not_needed" | "verified_deleted" | "unresolved" | "foreign_resource_denied";
  deletionObservation: "not_observed" | "destroyed" | "absent";
  record: DevelopmentLabRecord;
  productionQualified: false;
  memoryPersistenceClaimed: false;
};
export type DevelopmentLabOptions = {
  startedAtMs: number;
  now?: () => number;
  signal?: AbortSignal;
  resume?: DevelopmentLabRecord;
  cleanupOnly?: boolean;
  persist(record: DevelopmentLabRecord): Promise<void>;
};

// Ownership and profile checks are separate: a wrong-size owned resource may be
// deleted, but no resource with different identity/labels is ever adopted/deleted.
function owned(value: DevelopmentLabSandbox, operation: DevelopmentLabOperation, id?: string) {
  return (
    typeof value.id === "string" &&
    uuid.test(value.id) &&
    (!id || value.id === id) &&
    value.name === operation.name &&
    canonical(value.labels) === canonical(operation.labels)
  );
}
function profile(value: DevelopmentLabSandbox) {
  return (
    value.sandboxClass === "container" &&
    value.snapshot === "daytona-small" &&
    value.cpu === 1 &&
    value.memoryGiB === 1 &&
    value.diskGiB === 3
  );
}

export async function runDevelopmentLab(
  configuration: unknown,
  operationId: string,
  port: DevelopmentLabPort,
  options: DevelopmentLabOptions,
): Promise<DevelopmentLabResult> {
  if (options.cleanupOnly !== undefined && typeof options.cleanupOnly !== "boolean")
    throw Error("DEVELOPMENT_LAB_RESUME_DENIED");
  const cleanupOnly = options.cleanupOnly === true;
  if (cleanupOnly && !options.resume) throw Error("DEVELOPMENT_LAB_RESUME_DENIED");
  const operation = prepareDevelopmentLabOperation(configuration, operationId, options.startedAtMs);
  const now = options.now ?? Date.now;
  let record: DevelopmentLabRecord = {
    operation,
    createAttempted: false,
    sandboxId: null,
    phase: "prepared",
  };
  if (options.resume) {
    if (
      Object.keys(options.resume).sort().join(",") !==
        "createAttempted,operation,phase,sandboxId" ||
      canonical(options.resume.operation) !== canonical(operation) ||
      ![
        "prepared",
        "create_requested",
        "created",
        "checking",
        "cleanup_requested",
        "deleted",
        "unresolved",
      ].includes(options.resume.phase) ||
      typeof options.resume.createAttempted !== "boolean" ||
      (options.resume.sandboxId !== null && !uuid.test(options.resume.sandboxId)) ||
      (options.resume.phase !== "prepared" && !options.resume.createAttempted) ||
      (options.resume.sandboxId !== null && !options.resume.createAttempted) ||
      (["created", "checking", "cleanup_requested", "deleted"].includes(options.resume.phase) &&
        options.resume.sandboxId === null)
    )
      throw Error("DEVELOPMENT_LAB_RESUME_DENIED");
    record = { ...options.resume, operation };
  }
  let sandbox: DevelopmentLabSandbox | null = null;
  let status: DevelopmentLabResult["status"] = "failed";
  let code = "DEVELOPMENT_LAB_FAILED";
  let cleanup: DevelopmentLabResult["cleanup"] = "not_needed";
  let deletionObservation: DevelopmentLabResult["deletionObservation"] = "not_observed";
  let checksPassed = false;
  let uncertainCreate = record.createAttempted && !record.sandboxId;
  if (record.phase === "deleted")
    return {
      status: "failed",
      code: cleanupOnly ? "DEVELOPMENT_LAB_CLEANUP_ONLY" : "DEVELOPMENT_LAB_ALREADY_FINISHED",
      cleanup: "verified_deleted",
      deletionObservation,
      record,
      productionQualified: false,
      memoryPersistenceClaimed: false,
    };
  const journal = async (phase: DevelopmentLabRecord["phase"]) => {
    record = { ...record, phase };
    await options.persist(structuredClone(record));
  };
  const checkpoint = () => {
    if (options.signal?.aborted) throw Error("DEVELOPMENT_LAB_CANCELLED");
    const current = now();
    if (
      !Number.isSafeInteger(current) ||
      current < operation.startedAtMs ||
      current >= operation.deadlineMs
    )
      throw Error("DEVELOPMENT_LAB_DEADLINE");
  };
  // Abort/deadline bounds local waiting. An in-flight effect remains uncertain;
  // the port must also bound transport and reconcile it by the original name.
  const call = async <T>(
    fn: (context: DevelopmentLabContext) => Promise<T>,
    cleanupCall = false,
  ): Promise<T> => {
    if (!cleanupCall) checkpoint();
    const remaining = cleanupCall ? 30_000 : Math.max(1, operation.deadlineMs - now());
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          fn({ deadlineMs: now() + remaining, signal: controller.signal }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error("DEVELOPMENT_LAB_DEADLINE"));
          }, remaining);
          if (!cleanupCall && options.signal) {
            listener = () => {
              controller.abort();
              reject(Error("DEVELOPMENT_LAB_CANCELLED"));
            };
            options.signal.addEventListener("abort", listener, { once: true });
            if (options.signal.aborted) listener();
          }
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (listener) options.signal?.removeEventListener("abort", listener);
    }
  };
  const verified = async (state: string) => {
    const result = await call((context) => port.inspect(sandbox!.id, context));
    if (!result || !owned(result, operation, sandbox!.id))
      throw Error("DEVELOPMENT_LAB_IDENTITY_DENIED");
    if (!profile(result)) throw Error("DEVELOPMENT_LAB_PROFILE_DENIED");
    if (result.state !== state) throw Error("DEVELOPMENT_LAB_STATE_DENIED");
    sandbox = result;
  };
  try {
    if (cleanupOnly) {
      // Cleanup has no allocation/probe authority and intentionally remains
      // available after the original allocation deadline or budget expires.
      await journal(record.phase);
      throw Error("DEVELOPMENT_LAB_CLEANUP_ONLY");
    }
    checkpoint();
    await journal(record.phase);
    const existing = await call((context) => port.getByName(operation.name, context));
    if (existing) {
      if (!owned(existing, operation, record.sandboxId ?? undefined)) {
        cleanup = "foreign_resource_denied";
        throw Error("DEVELOPMENT_LAB_IDENTITY_DENIED");
      }
      sandbox = existing;
      record = { ...record, createAttempted: true, sandboxId: existing.id };
    } else if (record.createAttempted || record.sandboxId) {
      uncertainCreate = true;
      throw Error("DEVELOPMENT_LAB_CREATE_UNRESOLVED");
    } else {
      record = { ...record, createAttempted: true };
      await journal("create_requested");
      uncertainCreate = true;
      sandbox = await call((context) =>
        port.create(
          {
            name: operation.name,
            labels: operation.labels,
            organizationId,
            region: "us",
            sandboxClass: "container",
            snapshot: "daytona-small",
            cpu: 1,
            memoryGiB: 1,
            diskGiB: 3,
            autoStopMinutes: 5,
            autoDeleteMinutes: 1,
            networkBlockAll: true,
            publicPreview: false,
          },
          context,
        ),
      );
      if (!owned(sandbox, operation)) {
        sandbox = null;
        throw Error("DEVELOPMENT_LAB_IDENTITY_DENIED");
      }
      record = { ...record, sandboxId: sandbox.id };
    }
    uncertainCreate = false;
    await journal("created");
    if (!profile(sandbox)) throw Error("DEVELOPMENT_LAB_PROFILE_DENIED");
    await verified("started");
    await journal("checking");
    await call((context) =>
      port.writeMarker(sandbox!.id, operation.markerPath, operation.markerValue, context),
    );
    if (
      (await call((context) => port.readMarker(sandbox!.id, operation.markerPath, context))) !==
      operation.markerValue
    )
      throw Error("DEVELOPMENT_LAB_MARKER_DENIED");
    await call((context) => port.stop(sandbox!.id, context));
    await verified("stopped");
    await call((context) => port.start(sandbox!.id, context));
    await verified("started");
    if (
      (await call((context) => port.readMarker(sandbox!.id, operation.markerPath, context))) !==
      operation.markerValue
    )
      throw Error("DEVELOPMENT_LAB_PERSISTENCE_DENIED");
    checkpoint();
    checksPassed = true;
    code = "DEVELOPMENT_LAB_CHECKS_PASSED";
  } catch (error) {
    let safe = "";
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string")
        safe = descriptor.value;
    } catch {
      // Arbitrary exception objects/proxy traps never escape the redacted result.
    }
    code = new Set([
      "DEVELOPMENT_LAB_CANCELLED",
      "DEVELOPMENT_LAB_DEADLINE",
      "DEVELOPMENT_LAB_IDENTITY_DENIED",
      "DEVELOPMENT_LAB_PROFILE_DENIED",
      "DEVELOPMENT_LAB_STATE_DENIED",
      "DEVELOPMENT_LAB_MARKER_DENIED",
      "DEVELOPMENT_LAB_PERSISTENCE_DENIED",
      "DEVELOPMENT_LAB_CREATE_UNRESOLVED",
      "DEVELOPMENT_LAB_CLEANUP_ONLY",
    ]).has(safe)
      ? safe
      : "DEVELOPMENT_LAB_PROVIDER_FAILED";
  } finally {
    // Reconcile uncertain creation only; never call create again.
    if (!sandbox && record.createAttempted) {
      try {
        const recovered = await call((context) => port.getByName(operation.name, context), true);
        if (recovered) {
          if (!owned(recovered, operation, record.sandboxId ?? undefined)) {
            cleanup = "foreign_resource_denied";
          } else {
            sandbox = recovered;
            record = { ...record, sandboxId: recovered.id };
            uncertainCreate = false;
          }
        } else if (record.sandboxId) {
          // A previously observed resource requires explicit terminal inspection.
          const result = await call((context) => port.inspect(record.sandboxId!, context), true);
          if (!result) {
            cleanup = "verified_deleted";
            deletionObservation = "absent";
            uncertainCreate = false;
          } else if (owned(result, operation, record.sandboxId!)) {
            sandbox = result;
            uncertainCreate = false;
          } else cleanup = "foreign_resource_denied";
        }
      } catch {
        cleanup = "unresolved";
      }
    }
    if (sandbox) {
      try {
        const current = await call((context) => port.inspect(sandbox!.id, context), true);
        if (!current) {
          cleanup = "verified_deleted";
          deletionObservation = "absent";
        } else if (!owned(current, operation, sandbox.id)) cleanup = "foreign_resource_denied";
        else if (current.state === "destroyed") {
          cleanup = "verified_deleted";
          deletionObservation = "destroyed";
        } else {
          await journal("cleanup_requested");
          await call((context) => port.delete(sandbox!.id, context), true);
          const terminal = await call((context) => port.inspect(sandbox!.id, context), true);
          if (
            terminal &&
            (!owned(terminal, operation, sandbox.id) || terminal.state !== "destroyed")
          )
            throw Error("DEVELOPMENT_LAB_DELETE_UNRESOLVED");
          cleanup = "verified_deleted";
          deletionObservation = terminal ? "destroyed" : "absent";
        }
      } catch {
        cleanup = "unresolved";
      }
    }
    if (uncertainCreate && cleanup !== "foreign_resource_denied") cleanup = "unresolved";
    status =
      checksPassed && cleanup === "verified_deleted"
        ? "passed"
        : cleanup === "unresolved" || cleanup === "foreign_resource_denied"
          ? "unresolved"
          : "failed";
    try {
      await journal(
        cleanup === "verified_deleted"
          ? "deleted"
          : cleanup === "not_needed"
            ? "prepared"
            : "unresolved",
      );
    } catch {
      status = "unresolved";
      code = "DEVELOPMENT_LAB_JOURNAL_FAILED";
    }
  }
  return {
    status,
    code,
    cleanup,
    deletionObservation,
    record,
    productionQualified: false,
    memoryPersistenceClaimed: false,
  };
}
