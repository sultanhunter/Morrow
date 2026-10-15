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

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = "docs/decisions/workos-operator-qualification.json";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const unavailable = () => Error("WORKOS_OPERATOR_INPUT_UNAVAILABLE");
export function isWorkosOperatorSourceDirectory() {
  try {
    return realpathSync(process.cwd()) === repositoryRoot;
  } catch {
    return false;
  }
}
export const workosOperatorSourcePaths = Object.freeze([
  ".nvmrc",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "packages/contracts/package.json",
  "packages/identity/package.json",
  "infra/local-engine.json",
  "infra/identity-role-prerequisites.sql",
  "migrations/manifest.json",
  "migrations/0001.identity-foundation.sql",
  "migrations/0002.identity-grants.sql",
  "migrations/0003.authentication-challenges.sql",
  "migrations/0004.workspace-access-revocation.sql",
  "migrations/0005.workspace-store-linking.sql",
  "migrations/0006.authentication-exchange-admission.sql",
  "packages/identity/src/authentication-exchange-admission.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/contracts/src/validation.ts",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "scripts/local-postgres-lab.mjs",
  "scripts/local-authentication-exchange-sql.mjs",
  "scripts/workos-operator-input.mjs",
  "scripts/workos-operator.mjs",
  "scripts/workos-operator-journal.mjs",
  "scripts/workos-operator-controller.mjs",
  "scripts/workos-operator-transport.mjs",
  "scripts/workos-operator-json.mjs",
  "scripts/workos-operator-listener.mjs",
  "scripts/workos-operator-lab.mjs",
  profilePath,
]);
const expectedProfile = Object.freeze({
  schema_version: 1,
  plan_sequence: 74,
  provider_id: "workos",
  environment_kind: "staging",
  environment_id: "environment_01M4HG7FV7X8EFXE1J9S6GG00R",
  application_id: "app_01M4HG7GEJJWTKG4W16RB98VZE",
  client_id: "client_01M4HG7GA0DX8C3PFSQHBP4BN3",
  binding_id: "workos_operator_staging",
  binding_revision: 1,
  origin: "http://127.0.0.1:4110",
  start_path: "/operator/workos/start",
  callback_path: "/operator/workos/callback",
  result_path: "/operator/workos/result",
  return_path: "/operator/workos/result",
  authorize_endpoint: "https://api.workos.com/user_management/authorize",
  token_endpoint: "https://api.workos.com/user_management/authenticate",
  max_flow_seconds: 300,
  max_post_seconds: 15,
  max_response_bytes: 131072,
  max_code_units: 4096,
  max_invalid_requests: 20,
  max_body_bytes: 1024,
  max_uri_bytes: 65536,
  max_header_bytes: 98304,
  max_posts: 1,
  max_initiations: 1,
  keyless_only: true,
  merchant_routes_enabled: false,
  actual_provider_status: "awaiting_owner_activation",
  issuer: "https://api.workos.com/user_management/client_01M4HG7GA0DX8C3PFSQHBP4BN3",
  jwks_endpoint: "https://api.workos.com/sso/jwks/client_01M4HG7GA0DX8C3PFSQHBP4BN3",
  max_jwks_reads: 1,
  max_jwks_response_bytes: 65536,
});
function sourceBytes(root, name) {
  const path = resolve(root, name);
  if (realpathSync(path) !== path) throw unavailable();
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024 * 1024)
      throw unavailable();
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw unavailable();
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
// Optional root is a trusted local test seam; the CLI never accepts a source root.
export function loadPublicWorkosOperatorScope(root = repositoryRoot) {
  try {
    if (typeof root !== "string" || !isAbsolute(root) || realpathSync(root) !== root)
      throw unavailable();
    const manifest = JSON.parse(sourceBytes(root, "docs/plan/source.json").toString("utf8"));
    const plan = manifest.sources?.plan;
    const planDigest = sha(sourceBytes(root, "docs/plan/build-plan.md"));
    if (
      plan?.page_id !== "page_b1ef27b80b788191b91e67cbb52f1037" ||
      plan.sequence !== 74 ||
      plan.sha256 !== planDigest
    )
      throw unavailable();
    const profileJson = sourceBytes(root, profilePath).toString("utf8");
    const profile = JSON.parse(profileJson);
    if (
      !profile ||
      Array.isArray(profile) ||
      Object.keys(profile).sort().join(",") !== Object.keys(expectedProfile).sort().join(",") ||
      Object.entries(expectedProfile).some(([key, value]) => profile[key] !== value)
    )
      throw unavailable();
    const bindingJson = JSON.stringify({
      bindingId: profile.binding_id,
      bindingRevision: profile.binding_revision,
      environmentId: profile.environment_id,
      applicationId: profile.application_id,
      clientId: profile.client_id,
      redirectUri: profile.origin + profile.callback_path,
      returnPath: profile.return_path,
    });
    const sources = workosOperatorSourcePaths.map((path) => [path, sha(sourceBytes(root, path))]);
    return JSON.stringify({
      schemaVersion: 1,
      planSequence: 74,
      planDigest,
      sourceDigest: sha(JSON.stringify(sources)),
      profileDigest: sha(profileJson),
      bindingDigest: sha(bindingJson),
      profileJson,
      bindingJson,
    });
  } catch {
    throw unavailable();
  }
}
function inside(path, root) {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child));
}
export function requirePrivateWorkosOperatorRoot(root, { create = false } = {}) {
  try {
    if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root)
      throw unavailable();
    for (const excluded of [
      repositoryRoot,
      resolve(repositoryRoot, "../../morrow-publish"),
      resolve(homedir(), "Desktop/Morrow"),
    ])
      if (inside(root, excluded)) throw unavailable();
    for (let ancestor = root; ; ancestor = dirname(ancestor)) {
      try {
        lstatSync(resolve(ancestor, ".git"));
        throw unavailable();
      } catch (error) {
        if (error?.code !== "ENOENT") throw unavailable();
      }
      if (dirname(ancestor) === ancestor) break;
    }
    if (create) mkdirSync(root, { mode: 0o700, recursive: false });
    const info = lstatSync(root, { bigint: true });
    if (
      realpathSync(root) !== root ||
      !info.isDirectory() ||
      info.uid !== BigInt(process.getuid()) ||
      (info.mode & 0o777n) !== 0o700n
    )
      throw unavailable();
    return Object.freeze({
      ownerUid: Number(info.uid),
      rootDevice: String(info.dev),
      rootInode: String(info.ino),
    });
  } catch {
    throw unavailable();
  }
}
export function readWorkosOperatorActivation(root) {
  const originalRoot = requirePrivateWorkosOperatorRoot(root);
  let fd;
  try {
    fd = openSync(resolve(root, "activation.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 16384
    )
      throw unavailable();
    const text = readFileSync(fd, "utf8"),
      after = fstatSync(fd),
      entry = lstatSync(resolve(root, "activation.json"));
    if (
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.uid !== info.uid ||
      after.nlink !== 1 ||
      (after.mode & 0o777) !== 0o600 ||
      entry.dev !== info.dev ||
      entry.ino !== info.ino ||
      entry.isSymbolicLink()
    )
      throw unavailable();
    const finalRoot = requirePrivateWorkosOperatorRoot(root);
    if (
      finalRoot.rootDevice !== originalRoot.rootDevice ||
      finalRoot.rootInode !== originalRoot.rootInode
    )
      throw unavailable();
    return text;
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
export function prepareWorkosOperatorActivation(root, scopeJson = loadPublicWorkosOperatorScope()) {
  try {
    if (typeof scopeJson !== "string" || scopeJson.length > 32768) throw unavailable();
    const scope = JSON.parse(scopeJson),
      binding = JSON.parse(scope.bindingJson),
      profile = JSON.parse(scope.profileJson);
    if (
      scope.schemaVersion !== 1 ||
      scope.planSequence !== 74 ||
      ![scope.planDigest, scope.sourceDigest, scope.profileDigest, scope.bindingDigest].every(
        (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
      ) ||
      Object.keys(scope).sort().join(",") !==
        [
          "schemaVersion",
          "planSequence",
          "planDigest",
          "sourceDigest",
          "profileDigest",
          "bindingDigest",
          "profileJson",
          "bindingJson",
        ]
          .sort()
          .join(",") ||
      Object.keys(profile).sort().join(",") !== Object.keys(expectedProfile).sort().join(",") ||
      Object.entries(expectedProfile).some(([key, value]) => profile[key] !== value) ||
      sha(scope.profileJson) !== scope.profileDigest ||
      sha(scope.bindingJson) !== scope.bindingDigest ||
      JSON.stringify(binding) !==
        JSON.stringify({
          bindingId: profile.binding_id,
          bindingRevision: profile.binding_revision,
          environmentId: profile.environment_id,
          applicationId: profile.application_id,
          clientId: profile.client_id,
          redirectUri: profile.origin + profile.callback_path,
          returnPath: profile.return_path,
        })
    )
      throw unavailable();
    const metadata = requirePrivateWorkosOperatorRoot(root, { create: true });
    const activation = {
      schemaVersion: 1,
      mode: "native",
      operationId: randomUUID(),
      activationId: randomUUID(),
      beginCommandId: randomUUID(),
      callbackCommandId: randomUUID(),
      planSequence: scope.planSequence,
      planDigest: scope.planDigest,
      sourceDigest: scope.sourceDigest,
      profileDigest: scope.profileDigest,
      bindingDigest: scope.bindingDigest,
      environmentId: binding.environmentId,
      applicationId: binding.applicationId,
      clientId: binding.clientId,
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      ...metadata,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      tokenEndpoint: profile.token_endpoint,
      maxInitiations: 1,
      maxPosts: 1,
      maxJwksReads: 1,
      ownerApproved: false,
      callbackRegistered: false,
      cleanupBaseline: false,
    };
    let fd;
    try {
      fd = openSync(
        resolve(root, "activation.json"),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, JSON.stringify(activation) + "\n");
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const directory = openSync(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return Object.freeze({
      status: "prepared_unapproved",
      callback: profile.origin + profile.callback_path,
      providerRequests: 0,
    });
  } catch {
    throw unavailable();
  }
}
