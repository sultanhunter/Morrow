import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseWorkosSessionStatusJson } from "../packages/identity/src/workos-session-status-json.ts";

export const authenticationOperatorHeld = () => Error("WORKOS_AUTHENTICATION_OPERATOR_HELD");
export const authenticationOperatorHash = (value) =>
  createHash("sha256").update(value).digest("hex");
export const authenticationOperatorId = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const authenticationOperatorDigest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const authenticationOperatorTime = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
export const authenticationOperatorCategories = Object.freeze([
  "ready",
  "evidence_observed",
  "already_used",
  "input_denied",
  "configuration_denied",
  "source_denied",
  "cancelled",
  "timeout",
  "before_jwks_denied",
  "before_post_denied",
  "target_denied",
  "before_page_denied",
  "credential_denied",
  "transport_failed",
  "response_origin_denied",
  "http_rejected",
  "content_denied",
  "body_denied",
  "shape_denied",
  "token_denied",
  "observation_denied",
  "observation_record_denied",
]);
export const authenticationOperatorRecords = Object.freeze([
  "claim.json",
  "initiation_started.json",
  "jwks_requested.json",
  "exchange_requested.json",
  "verified_target.json",
  "session_page_1_requested.json",
  "session_page_2_requested.json",
  "session_page_3_requested.json",
  "session_page_4_requested.json",
  "observation.json",
]);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uid = () => process.getuid();
const inside = (value, root) => value === root || value.startsWith(root + path.sep);
export function authenticationOperatorClosed(text, keys, cap = 16384) {
  const value = parseWorkosSessionStatusJson(text, cap);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw authenticationOperatorHeld();
  return Object.freeze(value);
}
export function authenticationOperatorIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.uid,
    stat.mode & 0o777,
    stat.nlink,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].join(":");
}
// Check every ancestor before mkdir/open. A user-level package.json is not a
// Git repository; actual .git ancestry and the known checkouts are excluded.
export function authenticationOperatorPrivatePath(
  value,
  { create = false, directory = true } = {},
) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    path.normalize(value) !== value ||
    inside(value, sourceRoot) ||
    inside(value, path.join(os.homedir(), "Desktop", "Morrow"))
  )
    throw authenticationOperatorHeld();
  const target = directory ? value : path.dirname(value);
  const parts = target.split(path.sep).filter(Boolean);
  let current = path.parse(target).root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT" || !create || i !== parts.length - 1 || !directory)
        throw authenticationOperatorHeld();
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw authenticationOperatorHeld();
    try {
      fs.lstatSync(path.join(current, ".git"));
      throw authenticationOperatorHeld();
    } catch (error) {
      if (error?.code !== "ENOENT") throw authenticationOperatorHeld();
    }
  }
  if (fs.realpathSync(target) !== target) throw authenticationOperatorHeld();
  const protectedParent = fs.lstatSync(directory ? value : target);
  if (protectedParent.uid !== uid() || (protectedParent.mode & 0o777) !== 0o700)
    throw authenticationOperatorHeld();
  return value;
}
export function authenticationOperatorReadPrivate(file, cap = 32768) {
  authenticationOperatorPrivatePath(file, { directory: false });
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== uid() ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size > cap
    )
      throw authenticationOperatorHeld();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (authenticationOperatorIdentity(before) !== authenticationOperatorIdentity(stat))
      throw authenticationOperatorHeld();
    const raw = fs.readFileSync(fd);
    if (
      raw.length > cap ||
      authenticationOperatorIdentity(fs.fstatSync(fd)) !== authenticationOperatorIdentity(stat) ||
      authenticationOperatorIdentity(fs.lstatSync(file)) !== authenticationOperatorIdentity(stat)
    )
      throw authenticationOperatorHeld();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    return Object.freeze({
      raw,
      text,
      identity: authenticationOperatorIdentity(stat),
      sha256: authenticationOperatorHash(raw),
    });
  } catch {
    throw authenticationOperatorHeld();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function authenticationOperatorAppend(root, name, value, fault = () => {}) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]*\.json$/.test(name))
    throw authenticationOperatorHeld();
  authenticationOperatorPrivatePath(root);
  let fd, directory;
  const step = (phase) => {
    if (fault(phase + ":" + name) !== undefined) throw authenticationOperatorHeld();
  };
  try {
    step("before_open");
    fd = fs.openSync(
      path.join(root, name),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    step("after_open");
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    step("after_write");
    fs.fsyncSync(fd);
    step("after_fsync");
    directory = fs.openSync(
      root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    fs.fsyncSync(directory);
    step("after_directory_fsync");
  } catch {
    throw authenticationOperatorHeld();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (directory !== undefined) fs.closeSync(directory);
  }
  return authenticationOperatorReadPrivate(path.join(root, name));
}
export function createWorkosAuthenticationOperatorJournal(
  root,
  claim,
  constraints,
  fault = () => {},
) {
  authenticationOperatorPrivatePath(root);
  const rootStat = fs.lstatSync(root),
    rootIdentity = [rootStat.dev, rootStat.ino, rootStat.uid].join(":"),
    expected = new Map();
  let failed = false,
    phase = "claimed",
    pages = 0,
    target = null,
    lastDigest = null,
    observationOutcome = null;
  const cursors = new Set();
  const checkpoint = () => {
    if (failed) throw authenticationOperatorHeld();
    try {
      authenticationOperatorPrivatePath(root);
      const stat = fs.lstatSync(root);
      if ([stat.dev, stat.ino, stat.uid].join(":") !== rootIdentity)
        throw authenticationOperatorHeld();
      for (const name of authenticationOperatorRecords) {
        const old = expected.get(name);
        if (old) {
          const next = authenticationOperatorReadPrivate(path.join(root, name));
          if (next.identity !== old.identity || !next.raw.equals(old.raw))
            throw authenticationOperatorHeld();
        } else {
          try {
            fs.lstatSync(path.join(root, name));
            throw authenticationOperatorHeld();
          } catch (error) {
            if (error?.code !== "ENOENT") throw authenticationOperatorHeld();
          }
        }
      }
      return true;
    } catch {
      failed = true;
      throw authenticationOperatorHeld();
    }
  };
  const append = (name, data) => {
    checkpoint();
    try {
      const saved = authenticationOperatorAppend(
        root,
        name,
        {
          schemaVersion: 1,
          operationId: claim.operationId,
          activationId: claim.activationId,
          sourceDigest: claim.sourceDigest,
          previousDigest: lastDigest,
          data,
        },
        fault,
      );
      expected.set(name, saved);
      lastDigest = saved.sha256;
      checkpoint();
      return true;
    } catch {
      failed = true;
      throw authenticationOperatorHeld();
    }
  };
  try {
    for (const name of authenticationOperatorRecords) {
      try {
        fs.lstatSync(path.join(root, name));
        throw authenticationOperatorHeld();
      } catch (error) {
        if (error?.code !== "ENOENT") throw authenticationOperatorHeld();
      }
    }
    const saved = authenticationOperatorAppend(root, "claim.json", claim, fault);
    expected.set("claim.json", saved);
    lastDigest = saved.sha256;
  } catch {
    failed = true;
    throw authenticationOperatorHeld();
  }
  return Object.freeze({
    checkpoint,
    initiation(text) {
      const v = authenticationOperatorClosed(text, ["beginCommandId", "challengeId"]);
      if (
        phase !== "claimed" ||
        !authenticationOperatorId(v.beginCommandId) ||
        !authenticationOperatorId(v.challengeId)
      )
        throw authenticationOperatorHeld();
      append("initiation_started.json", v);
      phase = "initiated";
      return true;
    },
    jwks(text) {
      const v = authenticationOperatorClosed(text, ["commandId", "admissionId"]);
      if (
        phase !== "initiated" ||
        !authenticationOperatorId(v.commandId) ||
        !authenticationOperatorId(v.admissionId)
      )
        throw authenticationOperatorHeld();
      append("jwks_requested.json", v);
      phase = "jwks";
      return true;
    },
    exchange(text) {
      const v = authenticationOperatorClosed(text, ["commandId", "admissionId"]);
      if (
        phase !== "jwks" ||
        !authenticationOperatorId(v.commandId) ||
        !authenticationOperatorId(v.admissionId)
      )
        throw authenticationOperatorHeld();
      append("exchange_requested.json", v);
      phase = "posted";
      return true;
    },
    target(text) {
      const v = authenticationOperatorClosed(text, [
        "schemaVersion",
        "operationId",
        "activationId",
        "sourceDigest",
        "environmentId",
        "applicationId",
        "clientId",
        "issuer",
        "subjectId",
        "providerSessionId",
        "tokenProfileDigest",
        "keySetDigest",
        "verifiedAtMs",
        "tokenExpiresAtMs",
      ]);
      if (
        phase !== "posted" ||
        v.schemaVersion !== 1 ||
        v.operationId !== claim.operationId ||
        v.activationId !== claim.activationId ||
        v.sourceDigest !== claim.sourceDigest ||
        v.environmentId !== constraints.binding.environmentId ||
        v.applicationId !== constraints.binding.applicationId ||
        v.clientId !== constraints.binding.clientId ||
        v.issuer !== constraints.issuer ||
        v.subjectId !== constraints.approvedSubjectId ||
        !/^session_[A-Z0-9]{26}$/.test(v.providerSessionId) ||
        constraints.priorSessionIds.includes(v.providerSessionId) ||
        !authenticationOperatorDigest(v.tokenProfileDigest) ||
        !authenticationOperatorDigest(v.keySetDigest) ||
        !authenticationOperatorTime(v.verifiedAtMs) ||
        !authenticationOperatorTime(v.tokenExpiresAtMs) ||
        v.tokenExpiresAtMs <= v.verifiedAtMs
      )
        throw authenticationOperatorHeld();
      append("verified_target.json", v);
      target = v;
      phase = "target";
      return true;
    },
    page(text, number) {
      const v = authenticationOperatorClosed(text, [
        "schemaVersion",
        "subjectId",
        "after",
        "limit",
        "order",
      ]);
      if (
        !target ||
        phase === "observed" ||
        number !== pages + 1 ||
        number > 4 ||
        v.schemaVersion !== 1 ||
        v.subjectId !== target.subjectId ||
        v.limit !== 100 ||
        v.order !== "asc" ||
        (pages === 0
          ? v.after !== null
          : typeof v.after !== "string" ||
            !/^session_[A-Z0-9]{26}$/.test(v.after) ||
            cursors.has(v.after))
      )
        throw authenticationOperatorHeld();
      append("session_page_" + number + "_requested.json", { ...v, pageNumber: number });
      if (v.after !== null) cursors.add(v.after);
      pages = number;
      phase = "page";
      return true;
    },
    observation(text) {
      const v = authenticationOperatorClosed(text, [
        "schemaVersion",
        "kind",
        "outcome",
        "category",
        "statusClass",
        "jwksGetCount",
        "codePostCount",
        "sessionGetCount",
        "observedAtMs",
        "expiresAtMs",
        "tokenProfileDigest",
        "keySetDigest",
        "observationProfileDigest",
      ]);
      const positive = v.outcome === "evidence_observed",
        emptyTimes = v.observedAtMs === null && v.expiresAtMs === null,
        validTimes =
          authenticationOperatorTime(v.observedAtMs) &&
          authenticationOperatorTime(v.expiresAtMs) &&
          v.expiresAtMs > v.observedAtMs;
      if (
        phase === "observed" ||
        v.schemaVersion !== 1 ||
        v.kind !== "historical_evidence_observation" ||
        !["evidence_observed", "held"].includes(v.outcome) ||
        !authenticationOperatorCategories.includes(v.category) ||
        (v.statusClass !== null && !/^[2-5]xx$/.test(v.statusClass)) ||
        ![0, 1].includes(v.jwksGetCount) ||
        ![0, 1].includes(v.codePostCount) ||
        !Number.isInteger(v.sessionGetCount) ||
        v.sessionGetCount < 0 ||
        v.sessionGetCount > pages ||
        v.jwksGetCount > Number(expected.has("jwks_requested.json")) ||
        v.codePostCount > Number(expected.has("exchange_requested.json")) ||
        (!emptyTimes && !validTimes) ||
        [v.tokenProfileDigest, v.keySetDigest, v.observationProfileDigest].some(
          (d) => d !== null && !authenticationOperatorDigest(d),
        ) ||
        (positive &&
          (!target ||
            !pages ||
            v.jwksGetCount !== 1 ||
            v.codePostCount !== 1 ||
            v.sessionGetCount !== pages ||
            !validTimes ||
            [v.tokenProfileDigest, v.keySetDigest, v.observationProfileDigest].some(
              (d) => d === null,
            )))
      )
        throw authenticationOperatorHeld();
      append("observation.json", v);
      observationOutcome = v.outcome;
      phase = "observed";
      return true;
    },
    credentialAllowed() {
      checkpoint();
      return target !== null && pages > 0 && phase !== "observed";
    },
    counts() {
      return Object.freeze({
        jwks: Number(expected.has("jwks_requested.json")),
        posts: Number(expected.has("exchange_requested.json")),
        pages,
        observation: observationOutcome,
      });
    },
    hold() {
      failed = true;
    },
  });
}
