import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve, dirname } from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const operationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
export const e2bLabSources = [
  "packages/infrastructure/src/synthetic-runtime-lab.ts",
  "packages/runtime-adapters/src/e2b/development-transport.ts",
  "packages/runtime-adapters/src/e2b/development-native.ts",
  "packages/runtime-adapters/package.json",
  "scripts/e2b-development-input.mjs",
  "scripts/e2b-development-lab.mjs",
  "scripts/e2b-template-qualification.mjs",
  "infra/labs/e2b-development.json",
  "package-lock.json",
];
export const e2bLabSha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function e2bLabSourceBinding(root) {
  const digests = Object.fromEntries(
    e2bLabSources.map((path) => [path, e2bLabSha(readFileSync(resolve(root, path)))]),
  );
  return { digests, sourceSha256: e2bLabSha(JSON.stringify(digests)) };
}
const deny = () => {
  throw Error("E2B_LAB_PRIVATE_INPUT_DENIED");
};
const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");

// Explicit committed activation gate (ADR-0002). New allocation, owned builds, image
// verification and template discovery need the active recipe profile sequence named
// here; a missing, unreadable or malformed gate, or a null value, denies them.
export function e2bActivationProfile(readFile = readFileSync) {
  try {
    const gate = JSON.parse(readFile("infra/labs/e2b-activation.json", "utf8"));
    return keys(gate, ["schema_version", "active_profile_sequence", "decision"]) &&
      gate.schema_version === 1 &&
      Number.isSafeInteger(gate.active_profile_sequence)
      ? gate.active_profile_sequence
      : null;
  } catch {
    return null;
  }
}

// This observation qualifies only one operator test; it cannot authorize a merchant run.
export function inspectE2BLabAccount(account, profile, nowMs = Date.now()) {
  const reasons = [];
  if (
    !account ||
    account.schema_version !== 1 ||
    account.plan_sequence !== 67 ||
    !uuid.test(profile?.projectId ?? "") ||
    account.project_id !== profile.projectId ||
    account.workspace !== "Personal Workspace" ||
    account.project_name !== "Sultanibne's Project" ||
    account.plan !== "Hobby" ||
    account.region !== "US-WEST-1" ||
    !Number.isSafeInteger(nowMs) ||
    !Number.isFinite(Date.parse(account.observed_at)) ||
    nowMs < Date.parse(account.observed_at) ||
    nowMs - Date.parse(account.observed_at) > 1_800_000
  )
    reasons.push("E2B_LAB_ACCOUNT_UNQUALIFIED");
  if (
    !/^\d{1,7}\.\d{2}$/.test(account?.free_credit_usd ?? "") ||
    Number(account.free_credit_usd) < 0.25 ||
    account?.paid_credit_usd !== "0.00" ||
    account?.payment_method_on_file !== false ||
    account?.automatic_charge_enabled !== false
  )
    reasons.push("E2B_LAB_FREE_CREDIT_UNQUALIFIED");
  if (
    account?.trial_eligibility_confirmed !== true ||
    account?.operator_access_authorized !== true ||
    account?.allocation_authorized !== true ||
    account?.private_access_receipt !== "owner_explicit"
  )
    reasons.push("E2B_LAB_ACCESS_UNQUALIFIED");
  const quote = account?.quote;
  const cpu = profile?.cpu,
    memory = profile?.memoryMiB;
  const additional = quote?.additional_expected_usd;
  const expected =
    Number.isSafeInteger(cpu) && Number.isSafeInteger(memory)
      ? 600 * (cpu * 0.000014 + (memory / 1024) * 0.0000045) + Number(additional)
      : NaN;
  if (
    !quote ||
    quote.cpu_usd_per_second !== "0.000014" ||
    quote.ram_gib_usd_per_second !== "0.0000045" ||
    !/^\d{1,3}\.\d{6}$/.test(additional ?? "") ||
    quote.all_applicable_meters_qualified !== true ||
    quote.profile_sha256 !== account.profile_sha256 ||
    !hash.test(account?.profile_sha256 ?? "") ||
    !Number.isFinite(expected) ||
    expected > 0.25 ||
    expected < 0 ||
    quote.maximum_wall_ms !== 600000 ||
    quote.credit_ceiling_usd !== "0.25"
  )
    reasons.push("E2B_LAB_QUOTE_UNQUALIFIED");
  return reasons;
}
export function parseE2BLabInput(value, expected) {
  try {
    if (
      !keys(value, [
        "accountObservationSha256",
        "apiKey",
        "environment",
        "operationId",
        "projectId",
        "profileSha256",
        "sourceSha256",
      ]) ||
      value.environment !== "development" ||
      !uuid.test(value.projectId) ||
      value.projectId !== expected.projectId ||
      !operationUuid.test(value.operationId) ||
      typeof value.apiKey !== "string" ||
      value.apiKey.length < 32 ||
      value.apiKey.length > 2048 ||
      /[\x00-\x20\x7f]/.test(value.apiKey)
    )
      deny();
    for (const key of ["accountObservationSha256", "profileSha256", "sourceSha256"])
      if (!hash.test(value[key]) || value[key] !== expected[key]) deny();
    return Object.freeze({ ...value });
  } catch {
    deny();
  }
}
function protectedFolder(root) {
  const stat = lstatSync(root);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700 ||
    stat.uid !== process.getuid() ||
    realpathSync(root) !== root
  )
    deny();
}
function syncFolder(root) {
  const fd = openSync(root, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function readProtected(file, maximum) {
  const stat = lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > maximum ||
    stat.nlink !== 1
  )
    deny();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size > maximum ||
      !opened.isFile() ||
      opened.uid !== process.getuid() ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.nlink !== 1
    )
      deny();
    const bytes = readFileSync(fd, "utf8");
    if (Buffer.byteLength(bytes) > maximum) deny();
    return JSON.parse(bytes);
  } finally {
    closeSync(fd);
  }
}
export function loadE2BLabInput(path, privateRoot, expected) {
  try {
    const root = resolve(privateRoot),
      file = resolve(path);
    protectedFolder(root);
    if (!isAbsolute(path) || dirname(file) !== root || realpathSync(file) !== file) deny();
    return parseE2BLabInput(readProtected(file, 8192), expected);
  } catch {
    deny();
  }
}

export function loadE2BReadOnlyAccess(path, privateRoot, expected) {
  try {
    const root = resolve(privateRoot),
      file = resolve(path);
    protectedFolder(root);
    if (!isAbsolute(path) || dirname(file) !== root || realpathSync(file) !== file) deny();
    const value = readProtected(file, 8192);
    if (
      !keys(value, [
        "schemaVersion",
        "projectId",
        "consoleProjectId",
        "workspaceId",
        "keyLabel",
        "apiKey",
        "accessAuthorized",
        "allocationAuthorized",
      ]) ||
      value.schemaVersion !== 1 ||
      value.projectId !== expected.projectId ||
      value.consoleProjectId !== expected.consoleProjectId ||
      value.workspaceId !== expected.workspaceId ||
      value.keyLabel !== "Morrow-qualification-2026-10-14" ||
      value.accessAuthorized !== true ||
      value.allocationAuthorized !== false ||
      typeof value.apiKey !== "string" ||
      !/^e2b_[A-Za-z0-9_-]{16,508}$/.test(value.apiKey)
    )
      deny();
    return Object.freeze({ apiKey: value.apiKey, projectId: value.projectId });
  } catch {
    deny();
  }
}

// One durable operation slot prevents a new UUID from bypassing uncertain effects.
// A crashed process mutex is retained for verified operator recovery, never auto-unlocked.
export function openE2BLabJournal(privateRoot, operationId, cleanupOnly = false) {
  const root = resolve(privateRoot);
  protectedFolder(root);
  if (!operationUuid.test(operationId)) deny();
  const lock = resolve(root, "e2b-development-active"),
    file = resolve(lock, "operation.json");
  const controller = resolve(root, "e2b-development-controller.lock");
  let fd;
  try {
    fd = openSync(controller, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch {
    throw Error("E2B_LAB_CONTROLLER_ALREADY_ACTIVE");
  }
  const stat = fstatSync(fd),
    controllerBytes = JSON.stringify({ operationId, pid: process.pid });
  try {
    writeFileSync(fd, controllerBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncFolder(root);
  let closed = false;
  const closeController = () => {
    if (closed) return;
    const current = lstatSync(controller);
    if (
      current.isSymbolicLink() ||
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      readFileSync(controller, "utf8") !== controllerBytes
    )
      deny();
    rmSync(controller);
    syncFolder(root);
    closed = true;
  };
  let envelope = null;
  try {
    if (!cleanupOnly && existsSync(resolve(root, `e2b-development-${operationId}-terminal.json`)))
      throw Error("E2B_LAB_OPERATION_ALREADY_TERMINAL");
    if (existsSync(lock)) {
      if (!cleanupOnly) throw Error("E2B_LAB_PENDING_OPERATION");
      protectedFolder(lock);
      envelope = readProtected(file, 32768);
      if (
        !keys(envelope, [
          "schemaVersion",
          "profile",
          "accountObservationSha256",
          "sourceDigests",
          "record",
        ]) ||
        envelope.schemaVersion !== 1 ||
        envelope.record?.operation?.operationId !== operationId ||
        !hash.test(envelope.accountObservationSha256)
      )
        deny();
    } else {
      if (cleanupOnly) throw Error("E2B_LAB_NO_OPERATION_TO_CLEAN");
      mkdirSync(lock, { mode: 0o700 });
      syncFolder(root);
    }
  } catch (error) {
    closeController();
    if (
      [
        "E2B_LAB_PENDING_OPERATION",
        "E2B_LAB_NO_OPERATION_TO_CLEAN",
        "E2B_LAB_OPERATION_ALREADY_TERMINAL",
      ].includes(error?.message)
    )
      throw Error(error.message);
    deny();
  }
  const persist = async (next) => {
    if (closed || next?.record?.operation?.operationId !== operationId) deny();
    if (
      envelope &&
      (JSON.stringify(next.record.operation) !== JSON.stringify(envelope.record.operation) ||
        JSON.stringify(next.profile) !== JSON.stringify(envelope.profile) ||
        next.accountObservationSha256 !== envelope.accountObservationSha256 ||
        JSON.stringify(next.sourceDigests) !== JSON.stringify(envelope.sourceDigests))
    )
      deny();
    protectedFolder(lock);
    const bytes = JSON.stringify(next) + "\n";
    if (Buffer.byteLength(bytes) > 32768) deny();
    const temp = resolve(lock, "operation.tmp");
    const writer = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(writer, bytes);
      fsyncSync(writer);
    } finally {
      closeSync(writer);
    }
    renameSync(temp, file);
    syncFolder(lock);
    envelope = JSON.parse(bytes);
  };
  return {
    envelope: envelope ? JSON.parse(JSON.stringify(envelope)) : null,
    persist,
    closeController,
    release(result) {
      if (closed || result?.record?.operation?.operationId !== operationId) deny();
      if (
        !envelope ||
        JSON.stringify(result.record) !== JSON.stringify(envelope.record) ||
        JSON.stringify(readProtected(file, 32768)) !== JSON.stringify(envelope)
      )
        deny();
      const verified =
        result.cleanup === "verified_deleted" && result.deletionObservation === "absent";
      const noEffect =
        result.cleanup === "not_needed" &&
        result.record.createAttempted === false &&
        result.record.sandboxId === null;
      if (result.status === "unresolved" || !(verified || noEffect)) return false;
      // Preserve a private original-operation terminal receipt before clearing the slot.
      const receipt = resolve(root, `e2b-development-${operationId}-terminal.json`);
      const writer = openSync(
        receipt,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(writer, JSON.stringify({ envelope, result }) + "\n");
        fsyncSync(writer);
      } finally {
        closeSync(writer);
      }
      syncFolder(root);
      rmSync(file);
      rmdirSync(lock);
      syncFolder(root);
      return true;
    },
  };
}
