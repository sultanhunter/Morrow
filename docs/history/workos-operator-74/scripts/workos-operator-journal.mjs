import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Scripts-only local durability boundary. The OS owner is trusted; this is not
// protection against a malicious owner or rollback of the underlying disk.
const records = Object.freeze([
  "claim.json",
  "initiation_started.json",
  "send_requested.json",
  "observation.json",
]);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = () => Error("WORKOS_OPERATOR_JOURNAL_HELD");
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
const opaqueId = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const uuid = (v) =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const sha = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const categories = new Set([
  "cryptographically_verified_candidate",
  "already_used",
  "input_denied",
  "configuration_denied",
  "cancelled",
  "timeout",
  "transport_failed",
  "http_rejected",
  "response_origin_denied",
  "content_denied",
  "body_denied",
  "shape_denied",
  "before_post_denied",
  "token_denied",
]);
function closed(value, keys) {
  if (typeof value !== "string" || value.length > 16384) throw fail();
  let p;
  try {
    p = JSON.parse(value);
  } catch {
    throw fail();
  }
  if (
    !p ||
    Array.isArray(p) ||
    typeof p !== "object" ||
    Object.keys(p).sort().join(",") !== [...keys].sort().join(",")
  )
    throw fail();
  return p;
}
function initiation(value) {
  const p = closed(value, ["beginCommandId", "challengeId", "expiresAt"]);
  if (
    !opaqueId(p.beginCommandId) ||
    !uuid(p.challengeId) ||
    typeof p.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(p.expiresAt)) ||
    new Date(p.expiresAt).toISOString() !== p.expiresAt
  )
    throw fail();
  return p;
}
function send(value) {
  const p = closed(value, [
    "callbackCommandId",
    "challengeId",
    "admissionId",
    "codeDigest",
    "requestDigest",
  ]);
  if (
    !opaqueId(p.callbackCommandId) ||
    !uuid(p.challengeId) ||
    !uuid(p.admissionId) ||
    !sha(p.codeDigest) ||
    !sha(p.requestDigest)
  )
    throw fail();
  return p;
}
function observation(value) {
  if (typeof value !== "string") throw fail();
  let p;
  try {
    p = JSON.parse(value);
  } catch {
    throw fail();
  }
  if (p?.outcome === "authorization_not_completed") {
    p = closed(value, ["outcome", "providerSessionCleanup"]);
    if (p.providerSessionCleanup !== "unknown") throw fail();
  } else {
    p = closed(value, ["outcome", "category", "statusClass", "providerSessionCleanup"]);
    if (
      !["held", "cryptographically_verified_candidate"].includes(p.outcome) ||
      !categories.has(p.category) ||
      ![null, "2xx", "3xx", "4xx", "5xx"].includes(p.statusClass) ||
      p.providerSessionCleanup !== "unknown" ||
      (p.outcome === "held" && p.category === "cryptographically_verified_candidate") ||
      (p.outcome === "cryptographically_verified_candidate" &&
        (p.category !== "cryptographically_verified_candidate" || p.statusClass !== "2xx"))
    )
      throw fail();
  }
  return p;
}
function directory(s) {
  return (
    s.isDirectory() &&
    !s.isSymbolicLink() &&
    (s.mode & 0o777n) === 0o700n &&
    s.uid === BigInt(process.getuid())
  );
}
function regular(s) {
  return (
    s.isFile() &&
    !s.isSymbolicLink() &&
    (s.mode & 0o777n) === 0o600n &&
    s.uid === BigInt(process.getuid()) &&
    s.nlink === 1n
  );
}
async function rootOf(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  )
    throw fail();
  const actual = await fs.realpath(value);
  if (
    actual !== value ||
    [
      repository,
      path.resolve(repository, "../../morrow-publish"),
      path.resolve(homedir(), "Desktop/Morrow"),
    ].some((parent) => inside(actual, parent))
  )
    throw fail();
  for (let parent = actual; ; parent = path.dirname(parent)) {
    for (const marker of [".git"]) {
      try {
        await fs.lstat(path.join(parent, marker));
        throw fail();
      } catch (error) {
        if (error?.code !== "ENOENT") throw fail();
      }
    }
    if (path.dirname(parent) === parent) break;
  }
  const before = await fs.lstat(actual, { bigint: true });
  if (!directory(before)) throw fail();
  const fd = await fs.open(
    actual,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const after = await fd.stat({ bigint: true });
    if (!directory(after) || !same(before, after)) throw fail();
    return { root: actual, metadata: after, fd };
  } catch {
    await fd.close().catch(() => {});
    throw fail();
  }
}
async function verifyRoot(root) {
  const [entry, opened] = await Promise.all([
    fs.lstat(root.root, { bigint: true }),
    root.fd.stat({ bigint: true }),
  ]);
  if (
    !directory(entry) ||
    !directory(opened) ||
    !same(entry, root.metadata) ||
    !same(opened, root.metadata) ||
    (await fs.realpath(root.root)) !== root.root
  )
    throw fail();
}
async function readRecord(root, name, identity) {
  const target = path.join(root.root, name);
  const before = await fs.lstat(target, { bigint: true });
  if (!regular(before) || before.size > 32768n) throw fail();
  const fd = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await fd.stat({ bigint: true });
    if (!regular(opened) || !same(before, opened) || (identity && !same(opened, identity)))
      throw fail();
    const content = await fd.readFile("utf8");
    const after = await fs.lstat(target, { bigint: true });
    if (!regular(after) || !same(opened, after)) throw fail();
    await verifyRoot(root);
    return content;
  } finally {
    await fd.close();
  }
}

export async function inspectWorkosOperatorJournal(rootPath) {
  let root;
  try {
    root = await rootOf(rootPath);
    let count = 0;
    for (const name of records) {
      try {
        JSON.parse(await readRecord(root, name));
        count++;
      } catch (error) {
        if (error?.code !== "ENOENT")
          return Object.freeze({
            state: "held",
            recordsPresent: null,
            providerSessionCleanup: "unknown",
          });
      }
    }
    await verifyRoot(root);
    await root.fd.close();
    root = null;
    return Object.freeze({
      state: count ? "held" : "empty",
      recordsPresent: count,
      providerSessionCleanup: "unknown",
    });
  } catch {
    return Object.freeze({
      state: "held",
      recordsPresent: null,
      providerSessionCleanup: "unknown",
    });
  } finally {
    if (root) await root.fd.close().catch(() => {});
  }
}

export async function createWorkosOperatorJournal(rootPath, claimJson, { fault = () => {} } = {}) {
  if (typeof claimJson !== "string" || claimJson.length > 16384) throw fail();
  let claim;
  try {
    claim = JSON.parse(claimJson);
  } catch {
    throw fail();
  }
  let root;
  const expected = new Map();
  let state = "claim",
    failed = false;
  const handles = new WeakMap();
  async function checkpoint() {
    if (failed) throw fail();
    await verifyRoot(root);
    for (const name of records) {
      if (expected.has(name)) {
        const prior = expected.get(name);
        if ((await readRecord(root, name, prior.identity)) !== prior.content) throw fail();
      } else {
        try {
          await fs.lstat(path.join(root.root, name));
          throw fail();
        } catch (error) {
          if (error?.code !== "ENOENT") throw fail();
        }
      }
    }
  }
  async function append(name, payload) {
    let fd;
    try {
      await checkpoint();
      await fault(name, "before_open");
      fd = await fs.open(
        path.join(root.root, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const initial = await fd.stat({ bigint: true });
      if (!regular(initial)) throw fail();
      await fault(name, "after_open");
      const content = JSON.stringify(payload) + "\n";
      if (content.length > 32768) throw fail();
      await fd.writeFile(content, "utf8");
      await fault(name, "after_write");
      await fd.sync();
      await fault(name, "after_file_sync");
      const current = await fs.lstat(path.join(root.root, name), { bigint: true });
      if (!regular(current) || !same(initial, current)) throw fail();
      await fd.close();
      fd = null;
      await fault(name, "after_close");
      await verifyRoot(root);
      await root.fd.sync();
      await fault(name, "after_directory_sync");
      expected.set(name, { content, identity: initial });
      await checkpoint();
    } catch {
      failed = true;
      if (fd) await fd.close().catch(() => {});
      throw fail();
    }
  }
  try {
    root = await rootOf(rootPath);
    if (
      String(root.metadata.uid) !== String(claim.ownerUid) ||
      String(root.metadata.dev) !== claim.rootDevice ||
      String(root.metadata.ino) !== claim.rootInode
    )
      throw fail();
    await append("claim.json", { schemaVersion: 1, record: "claim", activation: claim });
  } catch {
    if (root) await root.fd.close().catch(() => {});
    throw fail();
  }
  const claimDigest = hash(expected.get("claim.json").content);
  return Object.freeze({
    async markInitiationStarted(value) {
      if (state !== "claim") throw fail();
      const payload = initiation(value);
      state = "initiating";
      await append("initiation_started.json", {
        schemaVersion: 1,
        record: "initiation_started",
        claimDigest,
        ...payload,
      });
      state = "initiated";
    },
    async markSendRequested(value) {
      if (state !== "initiated") throw fail();
      const payload = send(value);
      state = "sending";
      await append("send_requested.json", {
        schemaVersion: 1,
        record: "send_requested",
        claimDigest,
        ...payload,
      });
      const handle = Object.freeze({});
      handles.set(handle, true);
      state = "send_ready";
      return handle;
    },
    async consumeSend(handle) {
      if (failed || state !== "send_ready" || handles.get(handle) !== true) throw fail();
      handles.delete(handle);
      state = "send_checking";
      try {
        await checkpoint();
        state = "send_consumed";
      } catch {
        failed = true;
        throw fail();
      }
    },
    async observe(value) {
      const payload = observation(value);
      if (
        !["initiated", "send_ready", "send_consumed"].includes(state) ||
        (state === "send_ready" && payload.outcome !== "held") ||
        (payload.outcome === "cryptographically_verified_candidate" && state !== "send_consumed")
      )
        throw fail();
      state = "observing";
      await append("observation.json", {
        schemaVersion: 1,
        record: "observation",
        claimDigest,
        ...payload,
      });
      state = "observed";
      await root.fd.close();
    },
    async hold() {
      failed = true;
      await root.fd.close().catch(() => {});
    },
  });
}
