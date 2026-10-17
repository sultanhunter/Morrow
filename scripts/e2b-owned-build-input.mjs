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
import { dirname, isAbsolute, resolve } from "node:path";
import {
  validateE2BOwnedBuildRecord,
  validateE2BOwnedBuildReadyProof,
} from "../packages/runtime-adapters/src/e2b/owned-build.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const deny = () => {
  throw Error("E2B_OWNED_BUILD_PRIVATE_INPUT_DENIED");
};
export const ownedBuildSha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const ownedBuildSources = [
  "packages/runtime-adapters/src/e2b/owned-image.ts",
  "packages/runtime-adapters/src/e2b/owned-build.ts",
  "scripts/e2b-owned-build-input.mjs",
  "scripts/e2b-owned-image-qualification.mjs",
  "scripts/e2b-owned-build-lab.mjs",
  "packages/runtime-adapters/src/e2b/development-transport.ts",
  "scripts/e2b-development-input.mjs",
  "infra/labs/e2b-owned-build.json",
  "package-lock.json",
];
export function ownedBuildSourceBinding(root) {
  const digests = Object.fromEntries(
    ownedBuildSources.map((p) => [p, ownedBuildSha(readFileSync(resolve(root, p)))]),
  );
  return { digests, sourceSha256: ownedBuildSha(JSON.stringify(digests)) };
}
function folder(root) {
  const st = lstatSync(root);
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    st.uid !== process.getuid() ||
    (st.mode & 0o777) !== 0o700 ||
    realpathSync(root) !== root
  )
    deny();
}
function sync(root) {
  const fd = openSync(root, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function protectedJson(file, max = 32768) {
  const st = lstatSync(file);
  if (
    st.isSymbolicLink() ||
    !st.isFile() ||
    st.uid !== process.getuid() ||
    (st.mode & 0o777) !== 0o600 ||
    st.nlink !== 1 ||
    st.size > max
  )
    deny();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const now = fstatSync(fd);
    if (
      !now.isFile() ||
      now.ino !== st.ino ||
      now.dev !== st.dev ||
      now.uid !== process.getuid() ||
      (now.mode & 0o777) !== 0o600 ||
      now.nlink !== 1 ||
      now.size > max
    )
      deny();
    const bytes = readFileSync(fd, "utf8");
    if (Buffer.byteLength(bytes) > max) deny();
    return JSON.parse(bytes);
  } finally {
    closeSync(fd);
  }
}
export function loadOwnedBuildAuthorization(file, privateRoot) {
  try {
    const root = resolve(privateRoot),
      path = resolve(file);
    folder(root);
    if (!isAbsolute(file) || dirname(path) !== root || realpathSync(path) !== path) deny();
    return protectedJson(path, 8192);
  } catch {
    deny();
  }
}
function unchangedBinding(record) {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    recipe: record.recipe,
    operation: record.operation,
  });
}
function recordShape(record, operationId) {
  try {
    return validateE2BOwnedBuildRecord(record).operation.operationId === operationId;
  } catch {
    return false;
  }
}
function envelopeShape(value, operationId) {
  return (
    value &&
    typeof value === "object" &&
    Object.keys(value).sort().join(",") === "record,schemaVersion,sourceDigests" &&
    value.schemaVersion === 1 &&
    recordShape(value.record, operationId) &&
    value.sourceDigests &&
    typeof value.sourceDigests === "object" &&
    !Array.isArray(value.sourceDigests) &&
    Object.keys(value.sourceDigests).join(",") === ownedBuildSources.join(",") &&
    Object.values(value.sourceDigests).every((v) => typeof v === "string" && hash.test(v)) &&
    ownedBuildSha(JSON.stringify(value.sourceDigests)) === value.record.operation.sourceSha256
  );
}
// Independent slot: template registration is an effect even when no sandbox exists.
export function openOwnedBuildJournal(privateRoot, operationId, reconcileOnly = false) {
  const root = resolve(privateRoot);
  folder(root);
  if (!uuid.test(operationId)) deny();
  const controller = resolve(root, "e2b-owned-build-controller.lock"),
    slot = resolve(root, "e2b-owned-build-active"),
    file = resolve(slot, "operation.json");
  let fd;
  try {
    fd = openSync(controller, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch {
    throw Error("E2B_OWNED_BUILD_CONTROLLER_ALREADY_ACTIVE");
  }
  const st = fstatSync(fd),
    lockBytes = JSON.stringify({ operationId, pid: process.pid });
  try {
    writeFileSync(fd, lockBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  sync(root);
  let closed = false,
    envelope = null;
  const closeController = () => {
    if (closed) return;
    const current = lstatSync(controller);
    if (
      current.isSymbolicLink() ||
      current.ino !== st.ino ||
      current.dev !== st.dev ||
      current.uid !== process.getuid() ||
      (current.mode & 0o777) !== 0o600 ||
      readFileSync(controller, "utf8") !== lockBytes
    )
      deny();
    rmSync(controller);
    sync(root);
    closed = true;
  };
  try {
    if (!reconcileOnly && existsSync(resolve(root, `e2b-owned-build-${operationId}-terminal.json`)))
      throw Error("E2B_OWNED_BUILD_ALREADY_TERMINAL");
    if (existsSync(slot)) {
      if (!reconcileOnly) throw Error("E2B_OWNED_BUILD_PENDING_OPERATION");
      folder(slot);
      envelope = protectedJson(file);
      if (!envelopeShape(envelope, operationId)) deny();
    } else {
      if (reconcileOnly) throw Error("E2B_OWNED_BUILD_NO_PENDING_OPERATION");
      mkdirSync(slot, { mode: 0o700 });
      sync(root);
    }
  } catch (error) {
    closeController();
    if (
      [
        "E2B_OWNED_BUILD_ALREADY_TERMINAL",
        "E2B_OWNED_BUILD_PENDING_OPERATION",
        "E2B_OWNED_BUILD_NO_PENDING_OPERATION",
      ].includes(error?.message)
    )
      throw Error(error.message);
    deny();
  }
  const persist = async (next) => {
    if (closed || !envelopeShape(next, operationId)) deny();
    if (
      envelope &&
      (unchangedBinding(next.record) !== unchangedBinding(envelope.record) ||
        JSON.stringify(next.sourceDigests) !== JSON.stringify(envelope.sourceDigests))
    )
      deny();
    if (
      envelope &&
      ((envelope.record.registrationAttempted && !next.record.registrationAttempted) ||
        (envelope.record.startAttempted && !next.record.startAttempted))
    )
      deny();
    folder(slot);
    const bytes = JSON.stringify(next) + "\n";
    if (Buffer.byteLength(bytes) > 32768) deny();
    const temp = resolve(slot, "operation.tmp"),
      writer = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(writer, bytes);
      fsyncSync(writer);
    } finally {
      closeSync(writer);
    }
    renameSync(temp, file);
    sync(slot);
    envelope = JSON.parse(bytes);
  };
  return {
    envelope: envelope ? JSON.parse(JSON.stringify(envelope)) : null,
    persist,
    closeController,
    releaseNoEffect(record) {
      if (
        closed ||
        !envelope ||
        !recordShape(record, operationId) ||
        JSON.stringify(record) !== JSON.stringify(envelope.record) ||
        JSON.stringify(protectedJson(file)) !== JSON.stringify(envelope)
      )
        deny();
      if (
        record.registrationAttempted ||
        record.startAttempted ||
        record.registrationVerified ||
        record.templateId !== null ||
        record.buildId !== null
      )
        return false;
      const receipt = resolve(root, `e2b-owned-build-${operationId}-terminal.json`);
      const writer = openSync(
        receipt,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(
          writer,
          JSON.stringify({
            envelope,
            outcome: "no_effect",
            catalogueDeleted: false,
            remoteCancellationVerified: false,
          }) + "\n",
        );
        fsyncSync(writer);
      } finally {
        closeSync(writer);
      }
      sync(root);
      rmSync(file);
      rmdirSync(slot);
      sync(root);
      return true;
    },
    retainTerminal(result) {
      if (
        closed ||
        !envelope ||
        !recordShape(result?.record, operationId) ||
        JSON.stringify(result.record) !== JSON.stringify(envelope.record) ||
        JSON.stringify(protectedJson(file)) !== JSON.stringify(envelope)
      )
        deny();
      // An error may precede a failed provider cancellation: it cannot release the slot.
      const observed = result.observation,
        original = result.record;
      if (
        !(
          result.status === "ready_retained" &&
          original.phase === "ready_retained" &&
          original.registrationVerified === true &&
          original.startAttempted === true &&
          observed?.status === "ready" &&
          observed.templateId === original.templateId &&
          observed.buildId === original.buildId &&
          observed.projectId === original.recipe.projectId &&
          observed.name === original.operation.name &&
          observed.private === true &&
          observed.cpu === 2 &&
          observed.memoryMiB === 512 &&
          Number.isSafeInteger(observed.finishedAtMs) &&
          observed.finishedAtMs >= original.operation.startedAtMs
        )
      )
        return false;
      try {
        validateE2BOwnedBuildReadyProof(observed, original);
      } catch {
        return false;
      }
      const receipt = resolve(root, `e2b-owned-build-${operationId}-terminal.json`);
      const writer = openSync(
        receipt,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      const terminal = {
        envelope,
        outcome: "ready_retained",
        catalogueDeleted: false,
        remoteCancellationVerified: false,
      };
      try {
        writeFileSync(writer, JSON.stringify(terminal) + "\n");
        fsyncSync(writer);
      } finally {
        closeSync(writer);
      }
      sync(root);
      rmSync(file);
      rmdirSync(slot);
      sync(root);
      return true;
    },
  };
}
