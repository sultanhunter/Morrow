// Operator-only, fixed-image build preparation. No merchant/runtime authority.
import { createHash } from "node:crypto";
import type { components } from "e2b";
import { e2bBounded, e2bGuarded, e2bRecord } from "./development-transport.js";

export const E2B_OWNED_BUILD_IMAGE =
  "e2bdev/base@sha256:4a369f01a820fe5e65f53c2c5727a78899daf86f0541b721097f289559c8b73f";
const API = "https://api.e2b.app";
const PROJECT = "22220c06-b76d-47b2-98d7-a1069d611e8f";
const WORKSPACE = "477b25a3-cd53-441c-b9ce-01c3bb48e378";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OP = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[0-9a-f]{64}$/;
function fail(): never {
  throw Error("E2B_OWNED_BUILD_DENIED");
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const closed = (value: unknown, keys: string[]) => {
  const result = e2bRecord(value);
  if (Object.keys(result).sort().join(",") !== [...keys].sort().join(",")) fail();
  return result;
};
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !SHA.test(value)) fail();
  return value as string;
};
export interface E2BOwnedBuildRecipe {
  schemaVersion: 1;
  task: "P04.T01h";
  planSequence: 60 | 65 | 66;
  workspaceId: string;
  projectId: string;
  imageRef: typeof E2B_OWNED_BUILD_IMAGE;
  cpu: 2;
  memoryMiB: 512;
  minFreeDiskMiB: 0;
  maximumObservationMs: 600000;
}
export interface E2BOwnedBuildOperation {
  operationId: string;
  name: string;
  recipeSha256: string;
  sourceSha256: string;
  accountObservationSha256: string;
  manifestProofSha256: string;
  startedAtMs: number;
  deadlineMs: number;
}
export interface E2BOwnedBuildAuthorization {
  schemaVersion: 1;
  operationId: string;
  workspaceId: string;
  projectId: string;
  recipeSha256: string;
  sourceSha256: string;
  accountObservationSha256: string;
  manifestProofSha256: string;
  quoteSha256: string;
  quoteVerified: true;
  allMetersQualified: true;
  recoveryQualified: true;
  creditCeilingUsd: "0.25";
  registrationReceipt: "owner_explicit";
  startReceipt: "owner_explicit";
  verifiedAtMs: number;
  expiresAtMs: number;
}
export type E2BOwnedBuildPhase =
  | "prepared"
  | "registering"
  | "registered"
  | "starting"
  | "observing"
  | "ready_retained"
  | "held";
export interface E2BOwnedBuildRecord {
  schemaVersion: 1;
  recipe: E2BOwnedBuildRecipe;
  operation: E2BOwnedBuildOperation;
  registrationAttempted: boolean;
  startAttempted: boolean;
  registrationVerified: boolean;
  templateId: string | null;
  buildId: string | null;
  phase: E2BOwnedBuildPhase;
}
export interface E2BOwnedBuildObservation {
  projectId: string;
  name: string;
  templateId: string;
  buildId: string;
  private: true;
  status: "waiting" | "building" | "ready" | "error";
  cpu: number;
  memoryMiB: number;
  diskMiB: number | null;
  envdVersion: string | null;
  createdAtMs: number;
  finishedAtMs: number | null;
}
export interface E2BOwnedBuildContext {
  deadlineMs: number;
  signal: AbortSignal;
}
export interface E2BOwnedBuildPort {
  proveProject(context: E2BOwnedBuildContext): Promise<void>;
  register(context: E2BOwnedBuildContext): Promise<E2BOwnedBuildObservation>;
  inspect(
    templateId: string,
    buildId: string,
    context: E2BOwnedBuildContext,
  ): Promise<E2BOwnedBuildObservation | null>;
  findOriginal(
    context: E2BOwnedBuildContext,
  ): Promise<{ candidates: E2BOwnedBuildObservation[]; complete: true }>;
  start(templateId: string, buildId: string, context: E2BOwnedBuildContext): Promise<void>;
}
export interface E2BOwnedBuildReport {
  status: "ready_retained" | "held";
  code: string;
  record: E2BOwnedBuildRecord;
  observation: E2BOwnedBuildObservation | null;
  candidateCount: number | null;
  templateRetained: boolean;
  catalogueDeleted: false;
  remoteCancellationVerified: false;
  runtimeProfileQualified: false;
  productionQualified: false;
  requestBodyDigests: { registrationBodySha256: string; startBodySha256: string };
}

const registrationBody = (
  record: E2BOwnedBuildRecord,
): components["schemas"]["TemplateBuildRequestV3"] => ({
  name: record.operation.name,
  cpuCount: 2,
  memoryMB: 512,
  minFreeDiskMb: 0,
});
const startBody = (): components["schemas"]["TemplateBuildStartV2"] => ({
  fromImage: E2B_OWNED_BUILD_IMAGE,
  steps: [],
  force: false,
});
export function e2bOwnedBuildRequestDigests(value: unknown) {
  const record = validateE2BOwnedBuildRecord(value);
  return Object.freeze({
    registrationBodySha256: sha(JSON.stringify(registrationBody(record))),
    startBodySha256: sha(JSON.stringify(startBody())),
  });
}

export function compileE2BOwnedBuildRecipe(value: unknown) {
  return e2bGuarded(() => {
    const r = closed(value, [
      "schemaVersion",
      "task",
      "planSequence",
      "workspaceId",
      "projectId",
      "imageRef",
      "cpu",
      "memoryMiB",
      "minFreeDiskMiB",
      "maximumObservationMs",
    ]);
    if (
      r.schemaVersion !== 1 ||
      r.task !== "P04.T01h" ||
      ![60, 65, 66].includes(r.planSequence as number) ||
      r.workspaceId !== WORKSPACE ||
      r.projectId !== PROJECT ||
      r.imageRef !== E2B_OWNED_BUILD_IMAGE ||
      r.cpu !== 2 ||
      r.memoryMiB !== 512 ||
      r.minFreeDiskMiB !== 0 ||
      r.maximumObservationMs !== 600000
    )
      fail();
    const recipe: E2BOwnedBuildRecipe = Object.freeze({
      schemaVersion: 1,
      task: "P04.T01h",
      planSequence: r.planSequence as 60 | 65 | 66,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      imageRef: E2B_OWNED_BUILD_IMAGE,
      cpu: 2,
      memoryMiB: 512,
      minFreeDiskMiB: 0,
      maximumObservationMs: 600000,
    });
    return Object.freeze({ recipe, recipeSha256: sha(JSON.stringify(recipe)) });
  });
}
export function prepareE2BOwnedBuildOperation(
  recipeValue: unknown,
  operationId: string,
  startedAtMs: number,
  sourceSha256: string,
  accountObservationSha256: string,
  manifestProofSha256: string,
): E2BOwnedBuildRecord {
  return e2bGuarded(() => {
    const { recipe, recipeSha256 } = compileE2BOwnedBuildRecipe(recipeValue);
    if (
      !OP.test(operationId) ||
      !Number.isSafeInteger(startedAtMs) ||
      startedAtMs < 0 ||
      !Number.isSafeInteger(startedAtMs + 600000)
    )
      fail();
    const operation = Object.freeze({
      operationId,
      name: `morrow-owned-${operationId}`,
      recipeSha256,
      sourceSha256: digest(sourceSha256),
      accountObservationSha256: digest(accountObservationSha256),
      manifestProofSha256: digest(manifestProofSha256),
      startedAtMs,
      deadlineMs: startedAtMs + 600000,
    });
    return Object.freeze({
      schemaVersion: 1,
      recipe,
      operation,
      registrationAttempted: false,
      startAttempted: false,
      registrationVerified: false,
      templateId: null,
      buildId: null,
      phase: "prepared",
    });
  });
}
export function validateE2BOwnedBuildRecord(value: unknown): E2BOwnedBuildRecord {
  return e2bGuarded(() => {
    const raw = closed(value, [
      "schemaVersion",
      "recipe",
      "operation",
      "registrationAttempted",
      "startAttempted",
      "registrationVerified",
      "templateId",
      "buildId",
      "phase",
    ]);
    const o = closed(raw.operation, [
      "operationId",
      "name",
      "recipeSha256",
      "sourceSha256",
      "accountObservationSha256",
      "manifestProofSha256",
      "startedAtMs",
      "deadlineMs",
    ]);
    const base = prepareE2BOwnedBuildOperation(
      raw.recipe,
      o.operationId as string,
      o.startedAtMs as number,
      o.sourceSha256 as string,
      o.accountObservationSha256 as string,
      o.manifestProofSha256 as string,
    );
    if (
      raw.schemaVersion !== 1 ||
      Object.entries(base.operation).some(([key, value]) => o[key] !== value) ||
      typeof raw.registrationAttempted !== "boolean" ||
      typeof raw.startAttempted !== "boolean" ||
      typeof raw.registrationVerified !== "boolean" ||
      typeof raw.phase !== "string" ||
      ![
        "prepared",
        "registering",
        "registered",
        "starting",
        "observing",
        "ready_retained",
        "held",
      ].includes(raw.phase)
    )
      fail();
    const idsNull = raw.templateId === null && raw.buildId === null;
    if (
      !idsNull &&
      (typeof raw.templateId !== "string" ||
        !ID.test(raw.templateId) ||
        typeof raw.buildId !== "string" ||
        !UUID.test(raw.buildId))
    )
      fail();
    if (
      (raw.registrationVerified && (!raw.registrationAttempted || idsNull)) ||
      (raw.startAttempted && (!raw.registrationVerified || idsNull)) ||
      (!raw.registrationAttempted && (!idsNull || raw.registrationVerified)) ||
      (raw.phase === "prepared" && raw.registrationAttempted) ||
      (raw.phase === "ready_retained" && !raw.startAttempted)
    )
      fail();
    return Object.freeze({
      ...base,
      registrationAttempted: raw.registrationAttempted,
      startAttempted: raw.startAttempted,
      registrationVerified: raw.registrationVerified,
      templateId: raw.templateId as string | null,
      buildId: raw.buildId as string | null,
      phase: raw.phase as E2BOwnedBuildPhase,
    });
  });
}
export function validateE2BOwnedBuildAuthorization(
  value: unknown,
  record: E2BOwnedBuildRecord,
  nowMs: number,
): E2BOwnedBuildAuthorization {
  return e2bGuarded(() => {
    const a = closed(value, [
      "schemaVersion",
      "operationId",
      "workspaceId",
      "projectId",
      "recipeSha256",
      "sourceSha256",
      "accountObservationSha256",
      "manifestProofSha256",
      "quoteSha256",
      "quoteVerified",
      "allMetersQualified",
      "recoveryQualified",
      "creditCeilingUsd",
      "registrationReceipt",
      "startReceipt",
      "verifiedAtMs",
      "expiresAtMs",
    ]);
    const o = record.operation;
    if (
      a.schemaVersion !== 1 ||
      a.operationId !== o.operationId ||
      a.workspaceId !== record.recipe.workspaceId ||
      a.projectId !== record.recipe.projectId ||
      a.recipeSha256 !== o.recipeSha256 ||
      a.sourceSha256 !== o.sourceSha256 ||
      a.accountObservationSha256 !== o.accountObservationSha256 ||
      a.manifestProofSha256 !== o.manifestProofSha256 ||
      a.quoteVerified !== true ||
      a.allMetersQualified !== true ||
      a.recoveryQualified !== true ||
      a.creditCeilingUsd !== "0.25" ||
      a.registrationReceipt !== "owner_explicit" ||
      a.startReceipt !== "owner_explicit" ||
      !Number.isSafeInteger(nowMs) ||
      !Number.isSafeInteger(a.verifiedAtMs) ||
      !Number.isSafeInteger(a.expiresAtMs) ||
      Number(a.verifiedAtMs) > nowMs ||
      nowMs - Number(a.verifiedAtMs) > 1800000 ||
      Number(a.expiresAtMs) <= nowMs ||
      Number(a.expiresAtMs) - Number(a.verifiedAtMs) > 1800000
    )
      fail();
    digest(a.quoteSha256);
    return Object.freeze({ ...a }) as unknown as E2BOwnedBuildAuthorization;
  });
}
function ownedObservation(
  value: unknown,
  record: E2BOwnedBuildRecord,
  expected?: { templateId: string; buildId: string },
): E2BOwnedBuildObservation {
  return e2bGuarded(() => {
    const o = closed(value, [
      "projectId",
      "name",
      "templateId",
      "buildId",
      "private",
      "status",
      "cpu",
      "memoryMiB",
      "diskMiB",
      "envdVersion",
      "createdAtMs",
      "finishedAtMs",
    ]);
    if (
      o.projectId !== record.recipe.projectId ||
      o.name !== record.operation.name ||
      o.private !== true ||
      typeof o.templateId !== "string" ||
      !ID.test(o.templateId) ||
      typeof o.buildId !== "string" ||
      !UUID.test(o.buildId) ||
      (expected && (o.templateId !== expected.templateId || o.buildId !== expected.buildId)) ||
      typeof o.status !== "string" ||
      !["waiting", "building", "ready", "error"].includes(o.status) ||
      !Number.isSafeInteger(o.cpu) ||
      Number(o.cpu) < 1 ||
      !Number.isSafeInteger(o.memoryMiB) ||
      Number(o.memoryMiB) < 128 ||
      (o.diskMiB !== null && (!Number.isSafeInteger(o.diskMiB) || Number(o.diskMiB) < 0)) ||
      (o.envdVersion !== null &&
        (typeof o.envdVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(o.envdVersion))) ||
      !Number.isSafeInteger(o.createdAtMs) ||
      Number(o.createdAtMs) < record.operation.startedAtMs ||
      (o.finishedAtMs !== null &&
        (!Number.isSafeInteger(o.finishedAtMs) || Number(o.finishedAtMs) < Number(o.createdAtMs)))
    )
      fail();
    return Object.freeze({ ...o }) as unknown as E2BOwnedBuildObservation;
  });
}
export function validateE2BOwnedBuildReadyProof(
  value: unknown,
  recordValue: unknown,
): E2BOwnedBuildObservation {
  return e2bGuarded(() => {
    const record = validateE2BOwnedBuildRecord(recordValue);
    if (
      !record.registrationVerified ||
      !record.startAttempted ||
      record.templateId === null ||
      record.buildId === null
    )
      fail();
    const observation = ownedObservation(value, record, {
      templateId: record.templateId,
      buildId: record.buildId,
    });
    if (
      observation.status !== "ready" ||
      observation.cpu !== 2 ||
      observation.memoryMiB !== 512 ||
      observation.diskMiB === null ||
      observation.diskMiB < 1 ||
      (observation.diskMiB > 10240 &&
        !(
          record.recipe.planSequence === 65 &&
          record.operation.operationId === "c423fb7d-6935-4917-8862-0b4bbf5a2961" &&
          record.operation.sourceSha256 ===
            "b20517ffdaac601c56edea1c2d75d81c636b914b7b546be7661aaf3236c8b4ce" &&
          record.templateId === "pdht65h2trfuizuvmotc" &&
          record.buildId === "4324bde3-d3a9-4d18-91c1-b2b1b3e80b80" &&
          observation.diskMiB === 12422 &&
          observation.envdVersion === "0.10.0"
        )) ||
      observation.envdVersion === null ||
      observation.finishedAtMs === null ||
      (Number(observation.envdVersion.split(".")[0]) === 0 &&
        Number(observation.envdVersion.split(".")[1]) < 2)
    )
      fail();
    return observation;
  });
}

export async function runE2BOwnedBuild(
  recordValue: unknown,
  port: E2BOwnedBuildPort,
  options: {
    mode: "build" | "reconcile";
    authorization: unknown;
    now?: () => number;
    signal: AbortSignal;
    persist: (record: E2BOwnedBuildRecord) => Promise<void>;
    pollWait?: () => Promise<void>;
    maximumPolls?: number;
  },
): Promise<E2BOwnedBuildReport> {
  let record = validateE2BOwnedBuildRecord(recordValue);
  const now = options.now ?? Date.now;
  const mode = options.mode;
  const maximumPolls = options.maximumPolls ?? 120;
  if (
    !Number.isSafeInteger(maximumPolls) ||
    maximumPolls < 1 ||
    maximumPolls > 120 ||
    (mode !== "build" && mode !== "reconcile")
  )
    fail();
  if (mode === "build" && record.recipe.planSequence !== 66) fail();
  const initialAuth =
    mode === "build"
      ? validateE2BOwnedBuildAuthorization(options.authorization, record, now())
      : null;
  const ctx = {
    deadlineMs: mode === "build" ? record.operation.deadlineMs : now() + 30000,
    signal: options.signal,
  };
  const current = () => {
    if (ctx.signal.aborted || now() >= ctx.deadlineMs) fail();
  };
  let observation: E2BOwnedBuildObservation | null = null,
    candidateCount: number | null = null;
  const update = async (changes: Partial<E2BOwnedBuildRecord>) => {
    record = validateE2BOwnedBuildRecord({ ...record, ...changes });
    await options.persist(record);
  };
  const report = (status: "ready_retained" | "held", code: string): E2BOwnedBuildReport => ({
    status,
    code,
    record,
    observation,
    candidateCount,
    templateRetained: record.templateId !== null,
    catalogueDeleted: false,
    remoteCancellationVerified: false,
    runtimeProfileQualified: false,
    productionQualified: false,
    requestBodyDigests: e2bOwnedBuildRequestDigests(record),
  });
  try {
    current();
    await port.proveProject(ctx);
    if (mode === "build") {
      if (record.registrationAttempted || record.startAttempted || record.phase !== "prepared")
        fail();
      const prior = await port.findOriginal(ctx);
      if (prior.complete !== true || !Array.isArray(prior.candidates) || prior.candidates.length)
        fail();
      current();
      validateE2BOwnedBuildAuthorization(initialAuth, record, now());
      await update({ registrationAttempted: true, phase: "registering" });
      current();
      observation = ownedObservation(await port.register(ctx), record);
      if (
        observation.status !== "waiting" ||
        observation.cpu !== 2 ||
        observation.memoryMiB !== 512
      )
        fail();
      await update({
        templateId: observation.templateId,
        buildId: observation.buildId,
        registrationVerified: true,
        phase: "registered",
      });
      const exact = { templateId: observation.templateId, buildId: observation.buildId };
      observation = ownedObservation(
        await port.inspect(exact.templateId, exact.buildId, ctx),
        record,
        exact,
      );
      if (
        observation.status !== "waiting" ||
        observation.cpu !== 2 ||
        observation.memoryMiB !== 512
      )
        fail();
      validateE2BOwnedBuildAuthorization(initialAuth, record, now());
      current();
      await update({ startAttempted: true, phase: "starting" });
      current();
      await port.start(exact.templateId, exact.buildId, ctx);
      await update({ phase: "observing" });
    } else if (
      record.templateId === null ||
      record.buildId === null ||
      !record.registrationVerified
    ) {
      const found = await port.findOriginal(ctx);
      if (
        found.complete !== true ||
        !Array.isArray(found.candidates) ||
        found.candidates.length > 800
      )
        fail();
      for (const value of found.candidates) ownedObservation(value, record);
      candidateCount = found.candidates.length;
      await update({ phase: "held" });
      return report("held", "E2B_OWNED_BUILD_REGISTRATION_PROVENANCE_UNRESOLVED");
    }
    if (record.templateId === null || record.buildId === null) fail();
    const expected = { templateId: record.templateId, buildId: record.buildId };
    for (let count = 0; count < maximumPolls; count++) {
      if (ctx.signal.aborted || now() >= ctx.deadlineMs) fail();
      observation = ownedObservation(
        await port.inspect(expected.templateId, expected.buildId, ctx),
        record,
        expected,
      );
      if (observation.status === "ready") {
        observation = validateE2BOwnedBuildReadyProof(observation, record);
        await update({ phase: "ready_retained" });
        return report("ready_retained", "E2B_OWNED_BUILD_READY_RETAINED");
      }
      if (observation.status === "error" || mode === "reconcile") break;
      if (count + 1 < maximumPolls)
        await (options.pollWait?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 1000)));
    }
    await update({ phase: "held" });
    return report("held", "E2B_OWNED_BUILD_REMOTE_RECOVERY_PENDING");
  } catch {
    try {
      await update({ phase: "held" });
    } catch {
      /* Preserve conservative in-memory attempt state. */
    }
    return report("held", "E2B_OWNED_BUILD_EFFECT_OR_PROOF_UNRESOLVED");
  }
}

type Registration = components["schemas"]["TemplateBuildRequestV3"];
type Start = components["schemas"]["TemplateBuildStartV2"];
export function createE2BOwnedBuildNativePort(
  options: {
    apiKey: string;
    record: E2BOwnedBuildRecord;
    authorization: unknown;
    mode: "build" | "reconcile";
  },
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
): E2BOwnedBuildPort {
  const captured = e2bGuarded(() => closed(options, ["apiKey", "record", "authorization", "mode"]));
  const record = validateE2BOwnedBuildRecord(captured.record);
  const keyValue = captured.apiKey;
  const mode = captured.mode;
  if (
    typeof keyValue !== "string" ||
    !/^e2b_[A-Za-z0-9_-]{16,508}$/.test(keyValue) ||
    (mode !== "build" && mode !== "reconcile")
  )
    fail();
  if (mode === "build" && record.recipe.planSequence !== 66) fail();
  const apiKey = keyValue;
  const now = dependencies.now ?? Date.now;
  const authorization =
    mode === "build"
      ? validateE2BOwnedBuildAuthorization(captured.authorization, record, now())
      : null;
  const request = dependencies.fetch ?? fetch;
  let registrationAttempted = false,
    startAttempted = false,
    projectProven = false;
  let originalReceipt: { templateId: string; buildId: string } | null = null;
  const implicit = () => {
    if (
      Object.keys(process.env).some(
        (key) =>
          key.startsWith("E2B_") || /^(HTTPS?_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY)$/i.test(key),
      )
    )
      fail();
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined &&
      process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "1"
    )
      fail();
  };
  implicit();
  async function http(
    path: string,
    method: "GET" | "POST",
    context: E2BOwnedBuildContext,
    accepted: number[],
    body?: string,
  ) {
    implicit();
    const url = `${API}${path}`;
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\r\n\0#]/.test(path) ||
      new URL(url).origin !== API
    )
      fail();
    return e2bBounded(context, now, async (signal) => {
      if (method === "POST") validateE2BOwnedBuildAuthorization(authorization, record, now());
      const headers: Record<string, string> = { "X-API-Key": apiKey, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await request(url, {
        method,
        headers,
        signal,
        redirect: "error",
        ...(body === undefined ? {} : { body }),
      });
      if (
        response.redirected ||
        (response.url && response.url !== url) ||
        !accepted.includes(response.status)
      ) {
        await response.body?.cancel().catch(() => undefined);
        fail();
      }
      if (
        response.status === 404 ||
        (method === "POST" && response.status === 202 && path.startsWith("/v2/templates/"))
      ) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, data: null, next: null };
      }
      const length = response.headers.get("content-length");
      if (
        !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "") ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > 262144))
      ) {
        await response.body?.cancel().catch(() => undefined);
        fail();
      }
      if (!response.body) fail();
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 262144) fail();
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const all = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
      const next = response.headers.get("x-next-token");
      if (next !== null && !/^[A-Za-z0-9_.~=-]{1,2048}$/.test(next)) fail();
      return { status: response.status, data, next };
    });
  }
  function normalize(rawValue: unknown, buildValue: unknown): E2BOwnedBuildObservation {
    const raw = e2bGuarded(() => e2bRecord(rawValue)),
      build = e2bGuarded(() => e2bRecord(buildValue));
    if (
      raw.public !== false ||
      typeof raw.templateID !== "string" ||
      !ID.test(raw.templateID) ||
      !Array.isArray(raw.aliases) ||
      raw.aliases.length !== 1 ||
      raw.aliases[0] !== record.operation.name ||
      !Array.isArray(raw.names) ||
      raw.names.length !== 1 ||
      typeof raw.names[0] !== "string" ||
      !/^[a-z0-9_-]{1,128}\//.test(raw.names[0]) ||
      raw.names[0].split("/").length !== 2 ||
      raw.names[0].split("/")[1] !== record.operation.name ||
      typeof build.buildID !== "string" ||
      !UUID.test(build.buildID)
    )
      fail();
    const templateCreatedAtMs = typeof raw.createdAt === "string" ? Date.parse(raw.createdAt) : NaN;
    if (
      !Number.isSafeInteger(templateCreatedAtMs) ||
      templateCreatedAtMs < record.operation.startedAtMs ||
      templateCreatedAtMs > now()
    )
      fail();
    const createdAtMs = typeof build.createdAt === "string" ? Date.parse(build.createdAt) : NaN;
    const finishedAtMs =
      build.finishedAt == null
        ? null
        : typeof build.finishedAt === "string"
          ? Date.parse(build.finishedAt)
          : NaN;
    if (createdAtMs > now() || (finishedAtMs !== null && finishedAtMs > now())) fail();
    return ownedObservation(
      {
        projectId: record.recipe.projectId,
        name: record.operation.name,
        templateId: raw.templateID,
        buildId: build.buildID,
        private: true,
        status: build.status,
        cpu: build.cpuCount,
        memoryMiB: build.memoryMB,
        diskMiB: build.diskSizeMB ?? null,
        envdVersion: build.envdVersion ?? null,
        createdAtMs,
        finishedAtMs,
      },
      record,
    );
  }
  async function proveProject(context: E2BOwnedBuildContext) {
    projectProven = false;
    const second = Math.floor(now() / 1000);
    const reply = await http(
      `/teams/${record.recipe.projectId}/metrics?start=${second - 60}&end=${second}`,
      "GET",
      context,
      [200],
    );
    if (!Array.isArray(reply.data)) fail();
    projectProven = true;
  }
  async function inspect(templateId: string, buildId: string, context: E2BOwnedBuildContext) {
    if (!projectProven || !ID.test(templateId) || !UUID.test(buildId)) fail();
    const cursors = new Set<string>();
    let next: string | null = null,
      found: E2BOwnedBuildObservation | null = null;
    for (let page = 0; page < 8; page++) {
      const query = new URLSearchParams({ limit: "100", ...(next ? { nextToken: next } : {}) });
      const reply = await http(`/templates/${templateId}?${query}`, "GET", context, [200, 404]);
      if (reply.status === 404) return null;
      const raw = e2bGuarded(() => e2bRecord(reply.data));
      if (raw.templateID !== templateId || !Array.isArray(raw.builds) || raw.builds.length > 100)
        fail();
      for (const value of raw.builds) {
        const build = e2bGuarded(() => e2bRecord(value));
        if (build.buildID !== buildId) continue;
        if (found) fail();
        found = normalize(raw, build);
      }
      next = reply.next;
      if (!next) return found;
      if (cursors.has(next)) fail();
      cursors.add(next);
    }
    return fail();
  }
  return {
    proveProject,
    inspect,
    async findOriginal(context) {
      if (!projectProven) fail();
      const cursors = new Set<string>(),
        ids = new Set<string>();
      let next: string | null = null;
      const candidates: E2BOwnedBuildObservation[] = [];
      for (let page = 0; page < 8; page++) {
        const query = new URLSearchParams({
          teamID: record.recipe.projectId,
          limit: "100",
          ...(next ? { nextToken: next } : {}),
        });
        const reply = await http(`/v2/templates?${query}`, "GET", context, [200]);
        if (!Array.isArray(reply.data) || reply.data.length > 100) fail();
        for (const value of reply.data) {
          const item = e2bGuarded(() => e2bRecord(value));
          if (
            typeof item.templateID !== "string" ||
            !ID.test(item.templateID) ||
            ids.has(item.templateID)
          )
            fail();
          ids.add(item.templateID);
          if (
            !Array.isArray(item.aliases) ||
            item.aliases.length > 32 ||
            item.aliases.some(
              (value) => typeof value !== "string" || value.length < 1 || value.length > 128,
            )
          )
            fail();
          if (!item.aliases.includes(record.operation.name)) continue;
          // A fresh waiting registration has no successful build ID in the
          // summary. Inspect its complete owned build catalogue, never guess it.
          const buildCursors = new Set<string>(),
            buildIds = new Set<string>();
          const before = candidates.length;
          let buildNext: string | null = null,
            complete = false;
          for (let buildPage = 0; buildPage < 8; buildPage++) {
            const buildQuery = new URLSearchParams({
              limit: "100",
              ...(buildNext ? { nextToken: buildNext } : {}),
            });
            const result = await http(
              `/templates/${item.templateID}?${buildQuery}`,
              "GET",
              context,
              [200],
            );
            const raw = e2bGuarded(() => e2bRecord(result.data));
            if (
              raw.templateID !== item.templateID ||
              !Array.isArray(raw.builds) ||
              raw.builds.length > 100
            )
              fail();
            for (const build of raw.builds) {
              const candidate = normalize(raw, build);
              if (buildIds.has(candidate.buildId) || candidates.length >= 800) fail();
              buildIds.add(candidate.buildId);
              candidates.push(candidate);
            }
            buildNext = result.next;
            if (!buildNext) {
              complete = true;
              break;
            }
            if (buildCursors.has(buildNext)) fail();
            buildCursors.add(buildNext);
          }
          if (!complete || candidates.length === before) fail();
        }
        next = reply.next;
        if (!next) return { candidates, complete: true };
        if (cursors.has(next)) fail();
        cursors.add(next);
      }
      return fail();
    },
    async register(context) {
      if (
        !projectProven ||
        mode !== "build" ||
        registrationAttempted ||
        record.registrationAttempted ||
        record.startAttempted
      )
        fail();
      validateE2BOwnedBuildAuthorization(authorization, record, now());
      registrationAttempted = true;
      const body: Registration = registrationBody(record);
      const reply = await http("/v3/templates", "POST", context, [202], JSON.stringify(body));
      const raw = e2bGuarded(() => e2bRecord(reply.data));
      if (
        raw.public !== false ||
        typeof raw.templateID !== "string" ||
        !ID.test(raw.templateID) ||
        typeof raw.buildID !== "string" ||
        !UUID.test(raw.buildID) ||
        !Array.isArray(raw.aliases) ||
        raw.aliases.length !== 1 ||
        raw.aliases[0] !== record.operation.name
      )
        fail();
      const actual = await inspect(raw.templateID, raw.buildID, context);
      if (!actual || actual.status !== "waiting" || actual.cpu !== 2 || actual.memoryMiB !== 512)
        fail();
      originalReceipt = { templateId: actual.templateId, buildId: actual.buildId };
      return actual;
    },
    async start(templateId, buildId, context) {
      if (
        !projectProven ||
        mode !== "build" ||
        startAttempted ||
        record.startAttempted ||
        !registrationAttempted ||
        originalReceipt?.templateId !== templateId ||
        originalReceipt?.buildId !== buildId
      )
        fail();
      validateE2BOwnedBuildAuthorization(authorization, record, now());
      const current = await inspect(templateId, buildId, context);
      if (
        !current ||
        current.status !== "waiting" ||
        current.cpu !== 2 ||
        current.memoryMiB !== 512
      )
        fail();
      validateE2BOwnedBuildAuthorization(authorization, record, now());
      startAttempted = true;
      const body: Start = startBody();
      await http(
        `/v2/templates/${templateId}/builds/${buildId}`,
        "POST",
        context,
        [202],
        JSON.stringify(body),
      );
    },
  };
}
