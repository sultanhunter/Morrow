import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import {
  authenticationOperatorHeld as heldError,
  authenticationOperatorHash as hash,
  authenticationOperatorClosed as closed,
  authenticationOperatorPrivatePath as privatePath,
  authenticationOperatorReadPrivate as readPrivate,
  authenticationOperatorAppend as append,
  authenticationOperatorIdentity as identity,
  authenticationOperatorDigest as digest,
  authenticationOperatorId as uuid,
  authenticationOperatorTime as time,
  authenticationOperatorRecords,
  createWorkosAuthenticationOperatorJournal,
} from "./workos-authentication-operator-journal.mjs";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = "docs/decisions/workos-authentication-operator-qualification.json";
const fixed = Object.freeze({
  schemaVersion: 1,
  protocolSequence: 80,
  providerId: "workos",
  apiOrigin: "https://api.workos.com",
  authorizePath: "/user_management/authorize",
  authenticatePath: "/user_management/authenticate",
  jwksPathTemplate: "/sso/jwks/{clientId}",
  issuerTemplate: "https://api.workos.com/user_management/{clientId}",
  sessionsPathTemplate: "/user_management/users/{subjectId}/sessions",
  loopbackOrigin: "http://127.0.0.1:4110",
  startPath: "/operator/workos/start",
  callbackPath: "/operator/workos/callback",
  resultPath: "/operator/workos/result",
  bindingId: "workos_authentication_operator_staging",
  bindingRevision: 1,
  flowMs: 300000,
  exchangeMs: 15000,
  compositionMs: 10000,
  nativeMs: 25000,
  evidenceLeaseMs: 5000,
  keysetLeaseMs: 300000,
  baselineMaxAgeMs: 300000,
  activationDefaultMs: 600000,
  activationMaxMs: 3600000,
  maxInitiations: 1,
  maxJwksReads: 1,
  maxPosts: 1,
  maxSessionReads: 4,
  pageLimit: 100,
  maxJwksBytes: 65536,
  maxExchangeBytes: 131072,
  maxPageBytes: 131072,
  maxTotalPageBytes: 524288,
  maxCodeUnits: 4096,
  maxKeyBytes: 4096,
  maxInvalid: 20,
  maxRequests: 64,
  maxBodyBytes: 1024,
  maxUrlUnits: 65536,
  maxHeaderBytes: 98304,
  keylessOnly: true,
  merchantAuthority: false,
  actualProviderStatus: "awaiting_new_owner_activation",
});
export function parseWorkosAuthenticationOperatorProfile(text) {
  const value = closed(text, [...Object.keys(fixed), "protectedBindingDigest"], 8192);
  if (
    !digest(value.protectedBindingDigest) ||
    Object.entries(fixed).some(([k, v]) => value[k] !== v)
  )
    throw heldError();
  return value;
}
export const workosAuthenticationOperatorSourcePaths = Object.freeze([
  "scripts/workos-authentication-operator-input.mjs",
  "scripts/workos-authentication-operator-journal.mjs",
  "scripts/workos-authentication-operator-controller.mjs",
  "scripts/workos-authentication-operator-native.mjs",
  "scripts/workos-authentication-operator-listener.mjs",
  "scripts/workos-authentication-operator-database.mjs",
  "scripts/workos-authentication-operator-lab.mjs",
  "scripts/workos-authentication-operator.mjs",
  profilePath,
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/authentication-exchange-admission.ts",
  "packages/identity/src/executor-role-preflight.ts",
  "packages/contracts/src/validation.ts",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "packages/identity/package.json",
  "packages/contracts/package.json",
  "scripts/local-authentication-exchange-sql.mjs",
  "scripts/local-postgres-lab.mjs",
  "infra/identity-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  "migrations/0001.identity-foundation.sql",
  "migrations/0002.identity-grants.sql",
  "migrations/0003.authentication-challenges.sql",
  "migrations/0004.workspace-access-revocation.sql",
  "migrations/0005.workspace-store-linking.sql",
  "migrations/0006.authentication-exchange-admission.sql",
  ".nvmrc",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
]);
// The native82 operator is retired: its one approved allowance was consumed and the
// staging session was revoked. Native scope loading is denied unconditionally instead
// of relying on a plan-sequence mismatch (ADR-0002). Re-enabling it needs a new
// owner-approved ADR. The synthetic test seam below keeps its frozen protocol checks.
export function loadWorkosAuthenticationOperatorScope() {
  throw heldError();
}
export function isWorkosAuthenticationOperatorSourceDirectory() {
  try {
    const expected = fs.realpathSync(path.join(os.homedir(), "Desktop", "Morrow"));
    return fs.realpathSync(process.cwd()) === expected && fs.realpathSync(repository) === expected;
  } catch {
    return false;
  }
}
function scopeOf(text) {
  const s = closed(
    text,
    [
      "schemaVersion",
      "planSequence",
      "planDigest",
      "sourceDigest",
      "profileDigest",
      "protectedBindingDigest",
      "profileJson",
    ],
    32768,
  );
  const p = parseWorkosAuthenticationOperatorProfile(s.profileJson);
  if (
    s.schemaVersion !== 1 ||
    s.planSequence !== 82 ||
    ![s.planDigest, s.sourceDigest, s.profileDigest, s.protectedBindingDigest].every(digest) ||
    s.profileDigest !== hash(s.profileJson) ||
    p.protectedBindingDigest !== s.protectedBindingDigest
  )
    throw heldError();
  return { scope: s, profile: p };
}
function bindingOf(text, expected) {
  const b = closed(text, [
    "schemaVersion",
    "providerId",
    "environmentId",
    "applicationId",
    "clientId",
    "approvedSubjectId",
  ]);
  if (
    b.schemaVersion !== 1 ||
    b.providerId !== "workos" ||
    !/^environment_[A-Z0-9]{26}$/.test(b.environmentId) ||
    !/^app_[A-Z0-9]{26}$/.test(b.applicationId) ||
    !/^client_[A-Z0-9]{26}$/.test(b.clientId) ||
    !/^user_[A-Z0-9]{26}$/.test(b.approvedSubjectId) ||
    hash(text) !== expected
  )
    throw heldError();
  return b;
}
const activationKeys = [
  "schemaVersion",
  "kind",
  "mode",
  "operationId",
  "activationId",
  "beginCommandId",
  "callbackCommandId",
  "preparedAtMs",
  "expiresAtMs",
  "planSequence",
  "planDigest",
  "sourceDigest",
  "profileDigest",
  "protectedBindingDigest",
  "bindingPath",
  "bindingIdentity",
  "ownerUid",
  "rootDevice",
  "rootInode",
  "ownerApproved",
  "callbackRegistered",
  "baselineApproved",
  "keyApproved",
];
function activationOf(text) {
  const a = closed(text, activationKeys);
  if (
    a.schemaVersion !== 1 ||
    a.kind !== "workos_authentication_operator_activation" ||
    !["native", "synthetic"].includes(a.mode) ||
    ![a.operationId, a.activationId, a.beginCommandId, a.callbackCommandId].every(uuid) ||
    !time(a.preparedAtMs) ||
    !time(a.expiresAtMs) ||
    a.expiresAtMs <= a.preparedAtMs ||
    a.expiresAtMs > a.preparedAtMs + fixed.activationMaxMs ||
    a.planSequence !== 82 ||
    ![a.planDigest, a.sourceDigest, a.profileDigest, a.protectedBindingDigest].every(digest) ||
    typeof a.bindingPath !== "string" ||
    typeof a.bindingIdentity !== "string" ||
    ![a.ownerUid, a.rootDevice, a.rootInode].every(Number.isSafeInteger) ||
    [a.ownerApproved, a.callbackRegistered, a.baselineApproved, a.keyApproved].some(
      (v) => typeof v !== "boolean",
    )
  )
    throw heldError();
  return a;
}
const proposal = (a) =>
  Object.freeze({
    outcome: "prepared",
    ownerApproved: false,
    sourceDigest: a.sourceDigest,
    planDigest: a.planDigest,
    profileDigest: a.profileDigest,
    protectedBindingDigest: a.protectedBindingDigest,
    expiresAtMs: a.expiresAtMs,
    maxInitiations: 1,
    maxJwksReads: 1,
    maxPosts: 1,
    maxSessionReads: 4,
    credentialReads: 0,
    providerRequests: 0,
  });
function prepare(root, bindingPath, scopeJson, mode, clock) {
  const { scope } = scopeOf(scopeJson),
    at = clock();
  if (!time(at)) throw heldError();
  const bf = readPrivate(bindingPath, 8192);
  bindingOf(bf.text, scope.protectedBindingDigest);
  privatePath(root, { create: true });
  const existing = fs.readdirSync(root);
  if (existing.some((name) => path.join(root, name) !== bindingPath)) throw heldError();
  const st = fs.lstatSync(root);
  const a = {
    schemaVersion: 1,
    kind: "workos_authentication_operator_activation",
    mode,
    operationId: randomUUID(),
    activationId: randomUUID(),
    beginCommandId: randomUUID(),
    callbackCommandId: randomUUID(),
    preparedAtMs: at,
    expiresAtMs: at + fixed.activationDefaultMs,
    planSequence: 82,
    planDigest: scope.planDigest,
    sourceDigest: scope.sourceDigest,
    profileDigest: scope.profileDigest,
    protectedBindingDigest: scope.protectedBindingDigest,
    bindingPath,
    bindingIdentity: bf.identity,
    ownerUid: process.getuid(),
    rootDevice: st.dev,
    rootInode: st.ino,
    ownerApproved: false,
    callbackRegistered: false,
    baselineApproved: false,
    keyApproved: false,
  };
  append(root, "activation.json", a);
  return a;
}
export function prepareWorkosAuthenticationOperatorActivation(root, bindingPath) {
  try {
    return proposal(
      prepare(root, bindingPath, loadWorkosAuthenticationOperatorScope(), "native", Date.now),
    );
  } catch {
    return Object.freeze({
      outcome: "held",
      reason: "preparation_denied",
      credentialReads: 0,
      providerRequests: 0,
    });
  }
}
export function inspectWorkosAuthenticationOperatorRun(root) {
  try {
    privatePath(root);
    const a = activationOf(readPrivate(path.join(root, "activation.json")).text);
    const records = authenticationOperatorRecords
      .filter((n) => fs.existsSync(path.join(root, n)))
      .map((n) => ({ name: n, sha256: readPrivate(path.join(root, n)).sha256 }));
    return Object.freeze({
      outcome: "inspected",
      ownerApproved: a.ownerApproved,
      sourceDigest: a.sourceDigest,
      planDigest: a.planDigest,
      profileDigest: a.profileDigest,
      claimed: records.some((r) => r.name === "claim.json"),
      records: Object.freeze(records.map(Object.freeze)),
      effectHandles: 0,
      credentialReads: 0,
      providerRequests: 0,
    });
  } catch {
    return Object.freeze({
      outcome: "held",
      reason: "inspection_denied",
      credentialReads: 0,
      providerRequests: 0,
    });
  }
}
const runs = new WeakMap(),
  permits = new WeakMap();
function rootIdentity(root) {
  privatePath(root);
  const s = fs.lstatSync(root);
  return [s.dev, s.ino, s.uid].join(":");
}
function privateCredentialStat(root) {
  const s = fs.lstatSync(path.join(root, "credential.txt"));
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o777) !== 0o600 ||
    s.nlink !== 1 ||
    s.size < 16 ||
    s.size > fixed.maxKeyBytes
  )
    throw heldError();
  return identity(s);
}
export function workosAuthenticationOperatorEnvironmentAllowed() {
  return (
    (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "1") &&
    !Object.keys(process.env).some(
      (k) =>
        /^WORKOS_/i.test(k) ||
        /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|NODE_OPTIONS|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(
          k,
        ),
    )
  );
}
function claim(root, options) {
  let lockFd, entry;
  try {
    if (
      options.mode === "native" &&
      (!isWorkosAuthenticationOperatorSourceDirectory() ||
        process.version !== "v24.13.0" ||
        !workosAuthenticationOperatorEnvironmentAllowed())
    )
      return null;
    privatePath(root);
    const af = readPrivate(path.join(root, "activation.json")),
      a = activationOf(af.text),
      scopeJson = options.scopeJson(),
      { scope, profile } = scopeOf(scopeJson),
      rid = rootIdentity(root);
    if (
      a.mode !== options.mode ||
      a.ownerUid !== process.getuid() ||
      a.rootDevice + ":" + a.rootInode + ":" + a.ownerUid !== rid ||
      ["planDigest", "sourceDigest", "profileDigest", "protectedBindingDigest"].some(
        (k) => a[k] !== scope[k],
      ) ||
      !a.ownerApproved ||
      !a.callbackRegistered ||
      !a.baselineApproved ||
      !a.keyApproved
    )
      throw heldError();
    const bf = readPrivate(a.bindingPath, 8192),
      binding = bindingOf(bf.text, scope.protectedBindingDigest);
    if (bf.identity !== a.bindingIdentity) throw heldError();
    const baselineFile = readPrivate(path.join(root, "baseline.json")),
      baseline = closed(baselineFile.text, [
        "schemaVersion",
        "observedAtMs",
        "complete",
        "approvedSubjectId",
        "priorSessionIds",
        "environmentId",
        "applicationId",
        "clientId",
      ]);
    if (
      baseline.schemaVersion !== 1 ||
      baseline.complete !== true ||
      !time(baseline.observedAtMs) ||
      baseline.approvedSubjectId !== binding.approvedSubjectId ||
      ["environmentId", "applicationId", "clientId"].some((k) => baseline[k] !== binding[k]) ||
      !Array.isArray(baseline.priorSessionIds) ||
      baseline.priorSessionIds.length > 400 ||
      baseline.priorSessionIds.some(
        (s) => typeof s !== "string" || !/^session_[A-Z0-9]{26}$/.test(s),
      ) ||
      new Set(baseline.priorSessionIds).size !== baseline.priorSessionIds.length
    )
      throw heldError();
    Object.freeze(baseline.priorSessionIds);
    const crf = readPrivate(path.join(root, "credential_receipt.json")),
      cr = closed(crf.text, [
        "schemaVersion",
        "kind",
        "operationId",
        "activationId",
        "sourceDigest",
        "environmentId",
        "credentialSha256",
        "environmentReadback",
        "temporaryAcquisitionApproved",
        "removeLocalCopy",
        "approvalReference",
        "expiresAtMs",
      ]);
    const rf = readPrivate(path.join(root, "receipt.json")),
      r = closed(rf.text, [
        "schemaVersion",
        "kind",
        "operationId",
        "activationId",
        "activationSha256",
        "baselineSha256",
        "credentialReceiptSha256",
        "sourceDigest",
        "planDigest",
        "profileDigest",
        "protectedBindingDigest",
        "approvalReference",
        "ownerApproved",
        "callbackRegistered",
        "maxInitiations",
        "maxJwksReads",
        "maxPosts",
        "maxSessionReads",
        "expiresAtMs",
      ]);
    const at = options.clock();
    if (
      !time(at) ||
      at < a.preparedAtMs ||
      at >= a.expiresAtMs ||
      baseline.observedAtMs > at ||
      at - baseline.observedAtMs > profile.baselineMaxAgeMs ||
      cr.schemaVersion !== 1 ||
      cr.kind !== "temporary_existing_staging_key" ||
      cr.operationId !== a.operationId ||
      cr.activationId !== a.activationId ||
      cr.sourceDigest !== a.sourceDigest ||
      cr.environmentId !== binding.environmentId ||
      !digest(cr.credentialSha256) ||
      cr.environmentReadback !== true ||
      cr.temporaryAcquisitionApproved !== true ||
      cr.removeLocalCopy !== true ||
      typeof cr.approvalReference !== "string" ||
      cr.approvalReference.length < 1 ||
      cr.approvalReference.length > 256 ||
      !time(cr.expiresAtMs) ||
      cr.expiresAtMs <= at ||
      cr.expiresAtMs > a.expiresAtMs ||
      r.schemaVersion !== 1 ||
      r.kind !== "workos_authentication_operator_approval" ||
      r.operationId !== a.operationId ||
      r.activationId !== a.activationId ||
      r.activationSha256 !== af.sha256 ||
      r.baselineSha256 !== baselineFile.sha256 ||
      r.credentialReceiptSha256 !== crf.sha256 ||
      ["sourceDigest", "planDigest", "profileDigest", "protectedBindingDigest"].some(
        (k) => r[k] !== scope[k],
      ) ||
      r.approvalReference !== cr.approvalReference ||
      r.ownerApproved !== true ||
      r.callbackRegistered !== true ||
      r.maxInitiations !== 1 ||
      r.maxJwksReads !== 1 ||
      r.maxPosts !== 1 ||
      r.maxSessionReads !== 4 ||
      !time(r.expiresAtMs) ||
      r.expiresAtMs <= at ||
      r.expiresAtMs > a.expiresAtMs
    )
      throw heldError();
    const keyIdentity = privateCredentialStat(root);
    for (const name of [...authenticationOperatorRecords, "controller_lock.json"]) {
      try {
        fs.lstatSync(path.join(root, name));
        return null;
      } catch (error) {
        if (error?.code !== "ENOENT") throw heldError();
      }
    }
    lockFd = fs.openSync(
      path.join(root, "controller_lock.json"),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(lockFd, 0o600);
    fs.writeFileSync(
      lockFd,
      JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: randomUUID() }) + "\n",
    );
    fs.fsyncSync(lockFd);
    const rootFd = fs.openSync(
      root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(rootFd);
    } finally {
      fs.closeSync(rootFd);
    }
    const lockFile = readPrivate(path.join(root, "controller_lock.json"));
    const protectedFiles = new Map([
      [path.join(root, "activation.json"), af],
      [a.bindingPath, bf],
      [path.join(root, "baseline.json"), baselineFile],
      [path.join(root, "receipt.json"), rf],
      [path.join(root, "credential_receipt.json"), crf],
      [path.join(root, "controller_lock.json"), lockFile],
    ]);
    entry = {
      mode: options.mode,
      root,
      rootIdentity: rid,
      lockFd,
      lockFile,
      scopeJson,
      scope,
      profile,
      binding,
      bindingJson: bf.text,
      activation: a,
      baseline,
      credentialReceipt: cr,
      keyIdentity,
      clock: options.clock,
      scopeReader: options.scopeJson,
      closed: false,
      invalid: false,
      adopted: false,
      nativeClosed: false,
      credentialValue: null,
      previousTime: at,
      options,
    };
    const now = () => {
      const t = entry.clock();
      if (
        !time(t) ||
        t < entry.previousTime ||
        t >= Math.min(a.expiresAtMs, r.expiresAtMs, cr.expiresAtMs)
      )
        throw heldError();
      entry.previousTime = t;
      return t;
    };
    entry.current = () => {
      try {
        if (
          entry.closed ||
          entry.invalid ||
          (entry.mode === "native" &&
            (!isWorkosAuthenticationOperatorSourceDirectory() ||
              !workosAuthenticationOperatorEnvironmentAllowed()))
        )
          throw heldError();
        now();
        if (entry.scopeReader() !== scopeJson || rootIdentity(root) !== rid) throw heldError();
        for (const [p, before] of protectedFiles) {
          const next = readPrivate(p);
          if (next.identity !== before.identity || !next.raw.equals(before.raw)) throw heldError();
        }
        if (privateCredentialStat(root) !== keyIdentity) throw heldError();
        if (
          entry.credentialValue !== null &&
          readPrivate(path.join(root, "credential.txt"), 4096).sha256 !== cr.credentialSha256
        )
          throw heldError();
        entry.journal?.checkpoint();
        now();
        return true;
      } catch {
        entry.invalid = true;
        throw heldError();
      }
    };
    entry.current();
    const claimedAt = now();
    if (
      baseline.observedAtMs > claimedAt ||
      claimedAt - baseline.observedAtMs > profile.baselineMaxAgeMs
    )
      throw heldError();
    const claimRecord = {
      schemaVersion: 1,
      kind: "workos_authentication_operator_claim",
      operationId: a.operationId,
      activationId: a.activationId,
      sourceDigest: a.sourceDigest,
      planDigest: a.planDigest,
      profileDigest: a.profileDigest,
      protectedBindingDigest: a.protectedBindingDigest,
      ownerUid: a.ownerUid,
      rootDevice: a.rootDevice,
      rootInode: a.rootInode,
      activationSha256: af.sha256,
      baselineSha256: baselineFile.sha256,
      receiptSha256: rf.sha256,
      bindingSha256: bf.sha256,
      credentialReceiptSha256: crf.sha256,
      claimedAtMs: claimedAt,
    };
    entry.journal = createWorkosAuthenticationOperatorJournal(
      root,
      claimRecord,
      {
        binding,
        approvedSubjectId: binding.approvedSubjectId,
        priorSessionIds: baseline.priorSessionIds,
        issuer: profile.issuerTemplate.replace("{clientId}", binding.clientId),
      },
      options.fault,
    );
    entry.current();
    const committedAt = now();
    if (
      baseline.observedAtMs > committedAt ||
      committedAt - baseline.observedAtMs > profile.baselineMaxAgeMs
    )
      throw heldError();
    const admissionBindingJson = JSON.stringify({
      bindingId: profile.bindingId,
      bindingRevision: profile.bindingRevision,
      environmentId: binding.environmentId,
      applicationId: binding.applicationId,
      clientId: binding.clientId,
      redirectUri: profile.loopbackOrigin + profile.callbackPath,
      returnPath: profile.resultPath,
    });
    entry.context = Object.freeze({
      mode: entry.mode,
      scopeJson,
      profileJson: scope.profileJson,
      profile,
      binding,
      bindingJson: bf.text,
      admissionBindingJson,
      sourceRoot: repository,
      sourceDigest: scope.sourceDigest,
      planDigest: scope.planDigest,
      expiresAtMs: Math.min(a.expiresAtMs, r.expiresAtMs, cr.expiresAtMs),
      current: entry.current,
      root,
    });
    const run = Object.freeze(Object.create(null));
    runs.set(run, entry);
    lockFd = undefined;
    return run;
  } catch {
    if (entry) entry.invalid = true;
    if (lockFd !== undefined) {
      try {
        fs.closeSync(lockFd);
      } catch {}
    }
    // Retain a possibly durable lock/claim: an unknown attempt is never reset.
    return null;
  }
}
export function claimWorkosAuthenticationOperatorRun(root) {
  return claim(root, {
    mode: "native",
    scopeJson: loadWorkosAuthenticationOperatorScope,
    clock: Date.now,
    fault: () => {},
  });
}
export function readWorkosAuthenticationOperatorRun(run) {
  const e = runs.get(run);
  if (!e) throw heldError();
  e.current();
  return e.context;
}
export function adoptWorkosAuthenticationOperatorRun(run) {
  const e = runs.get(run);
  if (!e || e.adopted) throw heldError();
  e.current();
  e.adopted = true;
  const permit = Object.freeze(Object.create(null));
  permits.set(permit, { entry: e, used: false });
  return Object.freeze({
    context: e.context,
    activation: e.activation,
    journal: e.journal,
    nativeSubpermit: permit,
    clock: e.clock,
  });
}
export function consumeWorkosAuthenticationOperatorNativePermit(permit) {
  const p = permits.get(permit);
  if (!p || p.used) throw heldError();
  p.used = true;
  if (p.syntheticContext) return p.syntheticContext;
  const e = p.entry;
  e.current();
  return Object.freeze({
    ...e.context,
    approvedSubjectId: e.binding.approvedSubjectId,
    priorSessionIds: e.baseline.priorSessionIds,
    operationId: e.activation.operationId,
    activationId: e.activation.activationId,
    credentialExpiresAtMs: e.credentialReceipt.expiresAtMs,
    credential() {
      if (e.nativeClosed || !e.journal.credentialAllowed()) throw heldError();
      e.current();
      const key = readPrivate(path.join(e.root, "credential.txt"), 4096);
      if (key.identity !== e.keyIdentity || key.sha256 !== e.credentialReceipt.credentialSha256) {
        e.invalid = true;
        throw heldError();
      }
      const text = key.text.endsWith("\n") ? key.text.slice(0, -1) : key.text;
      if (text.length < 16 || text.length > 4096 || !/^[\x21-\x7e]+$/.test(text)) {
        e.invalid = true;
        throw heldError();
      }
      e.credentialValue = text;
      e.current();
      return text;
    },
    close() {
      e.nativeClosed = true;
      e.credentialValue = null;
    },
  });
}
export function releaseWorkosAuthenticationOperatorRun(run) {
  const e = runs.get(run);
  if (!e || e.closed) return Object.freeze({ credentialRemoved: false, lockReleased: false });
  e.closed = true;
  e.nativeClosed = true;
  e.credentialValue = null;
  e.journal.hold();
  let credentialRemoved = false,
    lockReleased = false;
  try {
    if (rootIdentity(e.root) !== e.rootIdentity) throw heldError();
    try {
      if (privateCredentialStat(e.root) !== e.keyIdentity) throw heldError();
      fs.unlinkSync(path.join(e.root, "credential.txt"));
      credentialRemoved = !fs.existsSync(path.join(e.root, "credential.txt"));
    } catch (error) {
      if (error?.code === "ENOENT") credentialRemoved = true;
    }
    const lock = readPrivate(path.join(e.root, "controller_lock.json"));
    if (lock.identity === e.lockFile.identity && lock.raw.equals(e.lockFile.raw)) {
      fs.unlinkSync(path.join(e.root, "controller_lock.json"));
      const fd = fs.openSync(
        e.root,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      lockReleased = true;
    }
  } catch {
  } finally {
    try {
      fs.closeSync(e.lockFd);
    } catch {}
  }
  return Object.freeze({ credentialRemoved, lockReleased });
}
// Explicit synthetic-only seams cannot produce a native permit. They use fake
// generated data and are never selected by the actual CLI.
export function createSyntheticWorkosAuthenticationOperatorNativePermit(value) {
  if (!value || typeof value !== "object") throw heldError();
  const profile = parseWorkosAuthenticationOperatorProfile(value.profileJson),
    binding = bindingOf(value.bindingJson, profile.protectedBindingDigest);
  if (
    typeof value.current !== "function" ||
    typeof value.credential !== "function" ||
    !uuid(value.operationId) ||
    !uuid(value.activationId) ||
    !digest(value.sourceDigest) ||
    value.approvedSubjectId !== binding.approvedSubjectId ||
    !Array.isArray(value.priorSessionIds) ||
    !time(value.expiresAtMs) ||
    !time(value.credentialExpiresAtMs)
  )
    throw heldError();
  const context = Object.freeze({
    ...value,
    mode: "synthetic",
    profile,
    binding,
    priorSessionIds: Object.freeze([...value.priorSessionIds]),
  });
  const permit = Object.freeze(Object.create(null));
  permits.set(permit, { syntheticContext: context, used: false });
  return permit;
}
export function prepareSyntheticWorkosAuthenticationOperatorRun(
  root,
  { clock = Date.now, currentScope, fault = () => {}, beforeClaim = () => {} } = {},
) {
  const binding = {
      schemaVersion: 1,
      providerId: "workos",
      environmentId: "environment_" + "A".repeat(26),
      applicationId: "app_" + "B".repeat(26),
      clientId: "client_" + "C".repeat(26),
      approvedSubjectId: "user_" + "D".repeat(26),
    },
    bindingJson = JSON.stringify(binding) + "\n";
  const profileJson = JSON.stringify({ ...fixed, protectedBindingDigest: hash(bindingJson) });
  const scopeJson = JSON.stringify({
    schemaVersion: 1,
    planSequence: 82,
    planDigest: hash("synthetic80plan"),
    sourceDigest: hash("synthetic80source"),
    profileDigest: hash(profileJson),
    protectedBindingDigest: hash(bindingJson),
    profileJson,
  });
  privatePath(root, { create: true });
  const bindingPath = path.join(root, "binding.json");
  append(root, "binding.json", binding);
  const a = prepare(root, bindingPath, scopeJson, "synthetic", clock);
  const approved = {
    ...a,
    ownerApproved: true,
    callbackRegistered: true,
    baselineApproved: true,
    keyApproved: true,
  };
  // Controlled synthetic preparation flips the activation before it can be
  // claimed. Actual activation is an independent later owner-only operation.
  fs.writeFileSync(path.join(root, "activation.json"), JSON.stringify(approved) + "\n", {
    mode: 0o600,
  });
  const baseline = {
    schemaVersion: 1,
    observedAtMs: clock(),
    complete: true,
    approvedSubjectId: binding.approvedSubjectId,
    priorSessionIds: [],
    environmentId: binding.environmentId,
    applicationId: binding.applicationId,
    clientId: binding.clientId,
  };
  append(root, "baseline.json", baseline);
  const key = "synthetic_" + randomBytes(24).toString("hex");
  fs.writeFileSync(path.join(root, "credential.txt"), key, { mode: 0o600, flag: "wx" });
  const cr = {
    schemaVersion: 1,
    kind: "temporary_existing_staging_key",
    operationId: a.operationId,
    activationId: a.activationId,
    sourceDigest: a.sourceDigest,
    environmentId: binding.environmentId,
    credentialSha256: hash(key),
    environmentReadback: true,
    temporaryAcquisitionApproved: true,
    removeLocalCopy: true,
    approvalReference: "synthetic_owner_approval",
    expiresAtMs: a.expiresAtMs,
  };
  append(root, "credential_receipt.json", cr);
  append(root, "receipt.json", {
    schemaVersion: 1,
    kind: "workos_authentication_operator_approval",
    operationId: a.operationId,
    activationId: a.activationId,
    activationSha256: readPrivate(path.join(root, "activation.json")).sha256,
    baselineSha256: readPrivate(path.join(root, "baseline.json")).sha256,
    credentialReceiptSha256: readPrivate(path.join(root, "credential_receipt.json")).sha256,
    sourceDigest: a.sourceDigest,
    planDigest: a.planDigest,
    profileDigest: a.profileDigest,
    protectedBindingDigest: a.protectedBindingDigest,
    approvalReference: cr.approvalReference,
    ownerApproved: true,
    callbackRegistered: true,
    maxInitiations: 1,
    maxJwksReads: 1,
    maxPosts: 1,
    maxSessionReads: 4,
    expiresAtMs: a.expiresAtMs,
  });
  beforeClaim(root, scopeJson);
  const run = claim(root, {
    mode: "synthetic",
    scopeJson: currentScope ? () => currentScope(scopeJson) : () => scopeJson,
    clock,
    fault,
  });
  if (!run) throw heldError();
  return run;
}
