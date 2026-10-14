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
import { isAbsolute, relative, resolve, sep } from "node:path";

const organizationId = "8862ff17-6109-4eb1-ac70-2f7bafba64ae";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
export const developmentLabSources = [
  "packages/infrastructure/src/daytona-development-lab.ts",
  "scripts/daytona-development-input.mjs",
  "scripts/daytona-development-lab.mjs",
  "scripts/daytona-development-transport.mjs",
  "infra/labs/daytona-development.json",
  "package-lock.json",
];
export const labSha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function developmentLabSourceBinding(root) {
  const digests = Object.fromEntries(
    developmentLabSources.map((path) => [path, labSha(readFileSync(resolve(root, path)))]),
  );
  return { digests, sourceSha256: labSha(JSON.stringify(digests)) };
}
const deny = () => {
  throw Error("DEVELOPMENT_LAB_PRIVATE_INPUT_DENIED");
};
const keys = (value, expected) =>
  value &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === expected.slice().sort().join(",");

// Public operator observation is a live prerequisite, never merchant authority.
export function inspectDevelopmentLabAccount(account, nowMs = Date.now(), mode = "allocate") {
  try {
    const reasons = [];
    if (
      !account ||
      account.schema_version !== 1 ||
      account.plan_sequence !== 54 ||
      account.organization_id !== organizationId ||
      account.region !== "us" ||
      !["allocate", "cleanup"].includes(mode) ||
      (mode === "allocate" ? account.tier !== 1 : ![1, 2, 3, 4].includes(account.tier)) ||
      !Number.isSafeInteger(nowMs) ||
      !Number.isFinite(Date.parse(account.observed_at)) ||
      nowMs < Date.parse(account.observed_at) ||
      nowMs - Date.parse(account.observed_at) > 30 * 60_000
    )
      reasons.push("DEVELOPMENT_LAB_ACCOUNT_OBSERVATION_UNQUALIFIED");
    if (
      mode === "allocate" &&
      (!/^\d{1,7}\.\d{2}$/.test(account?.free_credit_usd ?? "") ||
        Number(account.free_credit_usd) < 0.25 ||
        account.paid_credit_usd !== "0.00" ||
        account.automatic_top_up_disabled !== true)
    )
      reasons.push("DEVELOPMENT_LAB_FREE_CREDIT_UNQUALIFIED");
    if (
      (mode === "allocate" &&
        (account?.trial_eligibility_confirmed !== true ||
          account.container_creation_enabled !== true ||
          account.snapshot_identity_qualified !== true)) ||
      account.operator_access_authorized !== true
    )
      reasons.push("DEVELOPMENT_LAB_ACCESS_UNQUALIFIED");
    return reasons;
  } catch {
    return ["DEVELOPMENT_LAB_ACCOUNT_OBSERVATION_UNQUALIFIED"];
  }
}

export function parseDevelopmentLabInput(value, expected) {
  try {
    if (
      !keys(value, [
        "accountObservationSha256",
        "apiKey",
        "environment",
        "operationId",
        "organizationId",
        "profileSha256",
        "sourceSha256",
      ])
    )
      deny();
    if (
      value.environment !== "development" ||
      value.organizationId !== organizationId ||
      !uuid.test(value.operationId) ||
      typeof value.apiKey !== "string" ||
      value.apiKey.length < 32 ||
      value.apiKey.length > 2048 ||
      /[\x00-\x20\x7f]/.test(value.apiKey) ||
      !hash.test(value.profileSha256) ||
      !hash.test(value.sourceSha256) ||
      !hash.test(value.accountObservationSha256) ||
      value.profileSha256 !== expected.profileSha256 ||
      value.sourceSha256 !== expected.sourceSha256 ||
      value.accountObservationSha256 !== expected.accountObservationSha256
    )
      deny();
    return Object.freeze({ ...value });
  } catch {
    deny();
  }
}

function protectedFolder(root) {
  const folder = lstatSync(root);
  if (
    folder.isSymbolicLink() ||
    !folder.isDirectory() ||
    (folder.mode & 0o777) !== 0o700 ||
    folder.uid !== process.getuid()
  )
    deny();
}
function syncFolder(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
export function loadDevelopmentLabInput(path, privateRoot, expected) {
  try {
    if (!isAbsolute(path)) deny();
    const root = resolve(privateRoot),
      file = resolve(path);
    protectedFolder(root);
    const stat = lstatSync(file);
    if (
      !file.startsWith(root + sep) ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 8192 ||
      realpathSync(file) !== resolve(realpathSync(root), relative(root, file))
    )
      deny();
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor);
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) deny();
      return parseDevelopmentLabInput(JSON.parse(readFileSync(descriptor, "utf8")), expected);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    deny();
  }
}

// Exclusive host-local operation lock. Crash/unresolved effects retain it.
// Resume must use the original operation; a new UUID cannot escape pending cleanup.
export function openDevelopmentLabJournal(privateRoot, operationId, resume = false) {
  if (!uuid.test(operationId)) deny();
  const root = resolve(privateRoot);
  protectedFolder(root);
  const lock = resolve(root, "daytona-development-active");
  const file = resolve(lock, "operation.json");
  const controllerFile = resolve(root, "daytona-development-controller.lock");
  let descriptor;
  try {
    descriptor = openSync(
      controllerFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  } catch {
    throw Error("DEVELOPMENT_LAB_CONTROLLER_ALREADY_ACTIVE");
  }
  const controllerBytes = JSON.stringify({ operationId, pid: process.pid });
  const controllerStat = fstatSync(descriptor);
  try {
    writeFileSync(descriptor, controllerBytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncFolder(root);
  let closed = false;
  const closeController = () => {
    if (closed) return;
    const stat = lstatSync(controllerFile);
    if (
      stat.isSymbolicLink() ||
      stat.ino !== controllerStat.ino ||
      stat.dev !== controllerStat.dev ||
      readFileSync(controllerFile, "utf8") !== controllerBytes
    )
      deny();
    rmSync(controllerFile);
    syncFolder(root);
    closed = true;
  };
  // Read resume state only after acquiring the process-lifetime mutex.
  let record = null;
  try {
    if (existsSync(lock)) {
      if (!resume) throw Error("DEVELOPMENT_LAB_PENDING_OPERATION");
      protectedFolder(lock);
    } else {
      if (resume) throw Error("DEVELOPMENT_LAB_NO_OPERATION_TO_RESUME");
      mkdirSync(lock, { mode: 0o700 });
      syncFolder(root);
    }
    if (resume) {
      const stat = lstatSync(file);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid() ||
        stat.size > 16384
      )
        deny();
      const reader = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(reader);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev) deny();
        record = JSON.parse(readFileSync(reader, "utf8"));
      } finally {
        closeSync(reader);
      }
      if (record?.operation?.operationId !== operationId) deny();
    }
  } catch (error) {
    closeController();
    let safe;
    try {
      safe = Object.getOwnPropertyDescriptor(error, "message")?.value;
    } catch {}
    if (
      ["DEVELOPMENT_LAB_PENDING_OPERATION", "DEVELOPMENT_LAB_NO_OPERATION_TO_RESUME"].includes(safe)
    )
      throw Error(safe);
    deny();
  }
  return {
    record,
    async persist(next) {
      if (closed || next?.operation?.operationId !== operationId) deny();
      protectedFolder(lock);
      const bytes = JSON.stringify(next);
      if (bytes.length > 16384) deny();
      const tmp = resolve(lock, "operation.tmp");
      const writer = openSync(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(writer, bytes + "\n");
        fsyncSync(writer);
      } finally {
        closeSync(writer);
      }
      renameSync(tmp, file);
      syncFolder(lock);
    },
    closeController,
    release(result) {
      if (closed) throw Error("DEVELOPMENT_LAB_CONTROLLER_NOT_ACTIVE");
      if (!["not_needed", "verified_deleted"].includes(result.cleanup)) return;
      if (result.record.operation.operationId !== operationId) deny();
      rmSync(file, { force: true });
      rmdirSync(lock);
      syncFolder(root);
    },
  };
}
