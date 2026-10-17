import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkosSessionStatusJson } from "../packages/identity/src/workos-session-status-json.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = "docs/decisions/workos-session-status-qualification.json";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const unavailable = () => Error("WORKOS_SESSION_STATUS_INPUT_UNAVAILABLE");
const uuid = (v) =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const user = (v) => typeof v === "string" && /^user_[A-Z0-9]{26}$/.test(v);
const session = (v) => typeof v === "string" && /^session_[A-Z0-9]{26}$/.test(v);
const iso = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const fixedProfile = Object.freeze({
  schema_version: 1,
  plan_sequence: 75,
  provider_id: "workos",
  environment_kind: "staging",
  environment_id: "environment_01M4HG7FV7X8EFXE1J9S6GG00R",
  application_id: "app_01M4HG7GEJJWTKG4W16RB98VZE",
  client_id: "client_01M4HG7GA0DX8C3PFSQHBP4BN3",
  revision: 1,
  api_origin: "https://api.workos.com",
  max_observations: 1,
  max_gets: 4,
  page_limit: 100,
  page_bytes: 131072,
  total_bytes: 524288,
  max_seconds: 10,
  observation_age_seconds: 5,
  credential_capability: "broad_environment",
  actual_provider_status: "awaiting_owner_key_approval",
  merchant_routes_enabled: false,
});
function closed(text, keys, cap = 16384) {
  const value = parseWorkosSessionStatusJson(text, cap);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw unavailable();
  return Object.freeze(value);
}
export function parseWorkosSessionStatusProfile(text) {
  try {
    const p = closed(text, Object.keys(fixedProfile), 8192);
    if (Object.entries(fixedProfile).some(([k, v]) => p[k] !== v)) throw unavailable();
    return p;
  } catch {
    throw unavailable();
  }
}
export function workosSessionStatusObserverProfile(profileJson) {
  const p = parseWorkosSessionStatusProfile(profileJson);
  return JSON.stringify({
    schemaVersion: 1,
    providerId: "workos",
    environmentId: p.environment_id,
    applicationId: p.application_id,
    clientId: p.client_id,
    revision: p.revision,
  });
}
export const workosSessionStatusSourcePaths = Object.freeze([
  ".nvmrc",
  "package.json",
  "package-lock.json",
  "packages/identity/package.json",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "scripts/workos-session-status-input.mjs",
  "scripts/workos-session-status-transport.mjs",
  "scripts/workos-session-status-operator.mjs",
  profilePath,
]);
function identity(s) {
  return [s.dev, s.ino, s.uid, s.size, s.mtimeMs, s.ctimeMs].join(":");
}
const scopeKeys = [
  "schemaVersion",
  "planSequence",
  "planDigest",
  "sourceDigest",
  "profileDigest",
  "profileJson",
  "observerProfileJson",
];
function scopeOf(text) {
  const s = closed(text, scopeKeys, 16384);
  if (
    s.schemaVersion !== 1 ||
    s.planSequence !== 75 ||
    ![s.planDigest, s.sourceDigest, s.profileDigest].every(digest) ||
    sha(s.profileJson) !== s.profileDigest ||
    s.observerProfileJson !== workosSessionStatusObserverProfile(s.profileJson)
  )
    throw unavailable();
  return s;
}
// The native75 session-status reader is retired: its one approved GET allowance was
// consumed. Native scope loading is denied unconditionally instead of relying on a
// plan-sequence mismatch (ADR-0002). Re-enabling it needs a new owner-approved ADR.
export function loadWorkosSessionStatusScope() {
  throw unavailable();
}
function inside(child, parent) {
  const p = relative(parent, child);
  return p === "" || (p !== ".." && !p.startsWith(".." + sep) && !isAbsolute(p));
}
function privateRoot(root, create = false) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) throw unavailable();
  for (const excluded of [
    repository,
    resolve(repository, "../../morrow-publish"),
    resolve(homedir(), "Desktop/Morrow"),
  ])
    if (inside(root, excluded)) throw unavailable();
  for (let p = root; ; p = dirname(p)) {
    try {
      lstatSync(resolve(p, ".git"));
      throw unavailable();
    } catch (error) {
      if (error?.code !== "ENOENT") throw unavailable();
    }
    if (dirname(p) === p) break;
  }
  if (create) {
    const parent = dirname(root),
      parentInfo = lstatSync(parent);
    if (
      realpathSync(parent) !== parent ||
      !parentInfo.isDirectory() ||
      parentInfo.uid !== process.getuid() ||
      (parentInfo.mode & 0o777) !== 0o700
    )
      throw unavailable();
    mkdirSync(root, { mode: 0o700 });
  }
  const s = lstatSync(root);
  if (
    realpathSync(root) !== root ||
    !s.isDirectory() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o777) !== 0o700
  )
    throw unavailable();
  return s;
}
function readPrivate(root, name, limit = 16384) {
  let fd;
  try {
    const rootBefore = privateRoot(root);
    const path = resolve(root, name);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > limit
    )
      throw unavailable();
    const raw = readFileSync(fd),
      after = fstatSync(fd),
      entry = lstatSync(path),
      rootAfter = privateRoot(root);
    if (
      identity(before) !== identity(after) ||
      identity(before) !== identity(entry) ||
      rootBefore.dev !== rootAfter.dev ||
      rootBefore.ino !== rootAfter.ino
    )
      throw unavailable();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    return { raw, text, identity: identity(before) };
  } catch {
    throw unavailable();
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        throw unavailable();
      }
  }
}
function append(root, name, value) {
  const rootBefore = privateRoot(root);
  const fd = openSync(
    resolve(root, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const s = fstatSync(directory);
    if (s.dev !== rootBefore.dev || s.ino !== rootBefore.ino) throw unavailable();
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return readPrivate(root, name);
}
const activationKeys = [
  "schemaVersion",
  "mode",
  "operationId",
  "activationId",
  "planSequence",
  "planDigest",
  "sourceDigest",
  "profileDigest",
  "ownerUid",
  "rootDevice",
  "rootInode",
  "expiresAt",
  "ownerApproved",
  "environmentKeyApproved",
  "baselineApproved",
  "maxObservations",
  "maxGets",
];
function activationOf(text, s, metadata) {
  const a = closed(text, activationKeys);
  if (
    a.schemaVersion !== 1 ||
    a.mode !== "native" ||
    !uuid(a.operationId) ||
    !uuid(a.activationId) ||
    a.operationId === a.activationId ||
    a.planSequence !== 75 ||
    ["planDigest", "sourceDigest", "profileDigest"].some((k) => a[k] !== s[k]) ||
    a.ownerUid !== process.getuid() ||
    a.rootDevice !== String(metadata.dev) ||
    a.rootInode !== String(metadata.ino) ||
    !iso(a.expiresAt) ||
    a.maxObservations !== 1 ||
    a.maxGets !== 4 ||
    [a.ownerApproved, a.environmentKeyApproved, a.baselineApproved].some(
      (v) => typeof v !== "boolean",
    )
  )
    throw unavailable();
  return a;
}
export function prepareWorkosSessionStatusActivation(
  root,
  scopeJson = loadWorkosSessionStatusScope(),
) {
  try {
    const s = scopeOf(scopeJson),
      m = privateRoot(root, true);
    append(root, "activation.json", {
      schemaVersion: 1,
      mode: "native",
      operationId: randomUUID(),
      activationId: randomUUID(),
      planSequence: 75,
      planDigest: s.planDigest,
      sourceDigest: s.sourceDigest,
      profileDigest: s.profileDigest,
      ownerUid: process.getuid(),
      rootDevice: String(m.dev),
      rootInode: String(m.ino),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      ownerApproved: false,
      environmentKeyApproved: false,
      baselineApproved: false,
      maxObservations: 1,
      maxGets: 4,
    });
    return Object.freeze({
      status: "prepared_unapproved",
      sourceDigest: s.sourceDigest,
      planDigest: s.planDigest,
      profileDigest: s.profileDigest,
      providerRequests: 0,
      credentialReads: 0,
    });
  } catch {
    throw unavailable();
  }
}
export function inspectWorkosSessionStatusRun(root) {
  try {
    privateRoot(root);
    const present = (name) => {
      try {
        lstatSync(resolve(root, name));
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw unavailable();
      }
      readPrivate(root, name);
      return true;
    };
    return Object.freeze({
      state: "held",
      activationPresent: present("activation.json"),
      claimed: present("claim.json"),
      observationPresent: present("observation.json"),
      retriesAllowed: false,
    });
  } catch {
    throw unavailable();
  }
}
const permits = new WeakMap();
// Privileged OS owner is trusted. This is a scripts-only receipt/once boundary,
// not a production receipt issuer or protection against owner rollback.
export function claimWorkosSessionStatusRun(root) {
  try {
    const scopeJson = loadWorkosSessionStatusScope(),
      scope = scopeOf(scopeJson),
      metadata = privateRoot(root);
    const activationFile = readPrivate(root, "activation.json"),
      a = activationOf(activationFile.text, scope, metadata);
    if (![a.ownerApproved, a.environmentKeyApproved, a.baselineApproved].every((v) => v === true))
      return null;
    const startedAt = Date.now(),
      expiresAt = Date.parse(a.expiresAt);
    if (expiresAt <= startedAt || expiresAt > startedAt + 3600000) throw unavailable();
    const baselineFile = readPrivate(root, "baseline.json"),
      receiptFile = readPrivate(root, "receipt.json");
    const b = closed(baselineFile.text, [
      "schemaVersion",
      "sourceDigest",
      "environmentId",
      "applicationId",
      "clientId",
      "subjectId",
      "providerSessionId",
      "observedAt",
      "controlledOwned",
      "sessionStatus",
    ]);
    const r = closed(receiptFile.text, [
      "schemaVersion",
      "approvalQuestionId",
      "approvedAt",
      "operationId",
      "activationId",
      "sourceDigest",
      "planDigest",
      "profileDigest",
      "activationSha256",
      "baselineSha256",
      "credentialSha256",
      "subjectId",
      "providerSessionId",
      "environmentId",
      "applicationId",
      "clientId",
      "maxObservations",
      "maxGets",
      "credentialCapability",
      "existingEnvironmentKeyApproved",
      "readOnlyGetApproved",
      "baselineOwned",
    ]);
    const p = parseWorkosSessionStatusProfile(scope.profileJson);
    if (
      b.schemaVersion !== 1 ||
      b.sourceDigest !== scope.sourceDigest ||
      !user(b.subjectId) ||
      !session(b.providerSessionId) ||
      !iso(b.observedAt) ||
      b.controlledOwned !== true ||
      b.sessionStatus !== "Revoked" ||
      r.schemaVersion !== 1 ||
      typeof r.approvalQuestionId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(r.approvalQuestionId) ||
      !iso(r.approvedAt) ||
      Date.parse(r.approvedAt) > startedAt ||
      Date.parse(b.observedAt) > Date.parse(r.approvedAt) ||
      startedAt - Date.parse(b.observedAt) > 3600000 ||
      r.operationId !== a.operationId ||
      r.activationId !== a.activationId ||
      ["sourceDigest", "planDigest", "profileDigest"].some((k) => r[k] !== scope[k]) ||
      r.activationSha256 !== sha(activationFile.raw) ||
      r.baselineSha256 !== sha(baselineFile.raw) ||
      !digest(r.credentialSha256) ||
      r.subjectId !== b.subjectId ||
      r.providerSessionId !== b.providerSessionId ||
      r.maxObservations !== 1 ||
      r.maxGets !== 4 ||
      r.credentialCapability !== "broad_environment" ||
      r.existingEnvironmentKeyApproved !== true ||
      r.readOnlyGetApproved !== true ||
      r.baselineOwned !== true ||
      ["environmentId", "applicationId", "clientId"].some((k) => b[k] !== r[k]) ||
      b.environmentId !== p.environment_id ||
      b.applicationId !== p.application_id ||
      b.clientId !== p.client_id
    )
      throw unavailable();
    const queryJson = JSON.stringify({
      schemaVersion: 1,
      subjectId: b.subjectId,
      providerSessionId: b.providerSessionId,
    });
    let closedRun = false,
      credential = null,
      credentialFile = null;
    const expected = new Map([
      ["activation.json", activationFile],
      ["baseline.json", baselineFile],
      ["receipt.json", receiptFile],
    ]);
    const current = () => {
      try {
        const now = Date.now(),
          m = privateRoot(root);
        if (
          closedRun ||
          now < startedAt ||
          now >= expiresAt ||
          m.dev !== metadata.dev ||
          m.ino !== metadata.ino ||
          loadWorkosSessionStatusScope() !== scopeJson
        )
          throw unavailable();
        for (const [name, prior] of expected) {
          const next = readPrivate(root, name);
          if (next.identity !== prior.identity || next.text !== prior.text) throw unavailable();
        }
        if (credentialFile) {
          const next = readPrivate(root, "credential.txt", 4097);
          if (next.identity !== credentialFile.identity || !next.raw.equals(credentialFile.raw))
            throw unavailable();
        }
        return true;
      } catch {
        throw unavailable();
      }
    };
    current();
    const claimFile = append(root, "claim.json", {
      schemaVersion: 1,
      sourceDigest: scope.sourceDigest,
      operationId: a.operationId,
      activationId: a.activationId,
      activationSha256: sha(activationFile.raw),
      receiptSha256: sha(receiptFile.raw),
      baselineSha256: sha(baselineFile.raw),
      querySha256: sha(queryJson),
      maxObservations: 1,
      maxGets: 4,
    });
    expected.set("claim.json", claimFile);
    current();
    const context = Object.freeze({
      profileJson: scope.profileJson,
      observerProfileJson: scope.observerProfileJson,
      queryJson,
      subjectId: b.subjectId,
      deadlineMs: Math.min(expiresAt, startedAt + 10000),
      current,
      credential() {
        try {
          current();
          if (credential !== null) return credential;
          credentialFile = readPrivate(root, "credential.txt", 4097);
          if (sha(credentialFile.raw) !== r.credentialSha256) throw unavailable();
          const key = credentialFile.text.endsWith("\n")
            ? credentialFile.text.slice(0, -1)
            : credentialFile.text;
          if (key.length < 16 || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key))
            throw unavailable();
          credential = key;
          current();
          return credential;
        } catch {
          throw unavailable();
        }
      },
      observe(outcome) {
        try {
          current();
          if (!["observed_active", "not_observed_active", "held"].includes(outcome))
            throw unavailable();
          append(root, "observation.json", {
            schemaVersion: 1,
            sourceDigest: scope.sourceDigest,
            claimSha256: sha(claimFile.raw),
            outcome,
            clientBinding: "expected_only",
            sessionLiveness: "not_guaranteed",
          });
        } catch {
          throw unavailable();
        }
      },
      close() {
        closedRun = true;
        credential = null;
        credentialFile = null;
      },
    });
    const permit = Object.freeze({});
    permits.set(permit, { context, used: false });
    return permit;
  } catch {
    throw unavailable();
  }
}
export function consumeWorkosSessionStatusPermit(permit) {
  const entry = permits.get(permit);
  if (!entry || entry.used) throw unavailable();
  entry.used = true;
  entry.context.current();
  return entry.context;
}
export function isWorkosSessionStatusSourceDirectory() {
  try {
    return realpathSync(process.cwd()) === repository;
  } catch {
    return false;
  }
}
