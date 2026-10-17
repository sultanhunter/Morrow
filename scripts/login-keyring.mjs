// Login capsule keyring tool (P04.T02a D7, ADR-0007 item 6, decision K1).
//   node scripts/login-keyring.mjs --config <login-config.json> --out <absolute path>
// Writes one owner-only (0600) secrets file `{"LOGIN_CAPSULE_KEYRING":"…"}` for
// `wrangler deploy --env <e> --secrets-file <file>`, outside the checkout and the
// artifacts directory, and prints only the key id, windows and configuration
// digest. Key material never reaches stdout, stderr, logs or chat. The owner runs
// it for hosted environments; agents run it only on synthetic configurations.
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { artifactsRoot, repositoryRoot } from "./artifacts.mjs";

export const keyringWindowMs = Object.freeze({
  skew: 300000,
  encrypt: 90 * 86400000,
  decryptGrace: 300000,
});
const fail = (code) => {
  throw Error(code);
};
// Segment-aware: `<root>/..keys/x` is inside, `<root>/../x` is not.
const inside = (child, parent) => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
};

export function parseKeyringArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (
      !["--config", "--out"].includes(name) ||
      typeof value !== "string" ||
      Object.hasOwn(options, name)
    )
      fail("LOGIN_KEYRING_USAGE");
    options[name] = value;
  }
  if (!options["--config"]) fail("LOGIN_KEYRING_USAGE");
  if (!options["--out"]) fail("LOGIN_KEYRING_OUT_REQUIRED");
  return { config: options["--config"], out: options["--out"] };
}

// The destination must be a new absolute path whose parent is a real directory
// (no symlink anywhere in it) outside the repository and the artifacts directory.
export function checkKeyringDestination(
  out,
  { root = repositoryRoot, artifacts = artifactsRoot() } = {},
) {
  if (!isAbsolute(out) || resolve(out) !== out) fail("LOGIN_KEYRING_OUT_NOT_ABSOLUTE");
  const guarded = [root, artifacts].flatMap((path) => {
    try {
      return [path, realpathSync(path)];
    } catch {
      return [path];
    }
  });
  // Refuse by location first, so a destination inside the checkout or the
  // artifacts directory is refused even when its parent does not exist yet.
  if (guarded.some((path) => inside(out, path))) fail("LOGIN_KEYRING_OUT_INSIDE_CHECKOUT");
  const parent = dirname(out);
  let real;
  try {
    real = realpathSync(parent);
  } catch {
    fail("LOGIN_KEYRING_OUT_PARENT_MISSING");
  }
  if (real !== parent || !lstatSync(parent).isDirectory()) fail("LOGIN_KEYRING_OUT_PARENT_SYMLINK");
  try {
    lstatSync(out);
  } catch (error) {
    if (error?.code === "ENOENT") return out;
    throw error;
  }
  fail("LOGIN_KEYRING_OUT_EXISTS");
}

// A single version (K1): encryptFrom = t0 - 300 s, encryptUntil = t0 + 90 d,
// decryptUntil = encryptUntil + 300 s (the parser maximum).
export function buildLoginKeyring(configurationDigest, t0 = Date.now()) {
  if (typeof configurationDigest !== "string" || !/^[a-f0-9]{64}$/.test(configurationDigest))
    fail("LOGIN_KEYRING_DIGEST_INVALID");
  const keyId = randomUUID();
  const material = randomBytes(32);
  try {
    const version = {
      keyId,
      material: material.toString("base64url"),
      encryptFromMs: t0 - keyringWindowMs.skew,
      encryptUntilMs: t0 + keyringWindowMs.encrypt,
      decryptUntilMs: t0 + keyringWindowMs.encrypt + keyringWindowMs.decryptGrace,
    };
    return {
      keyringJson: JSON.stringify({
        schemaVersion: 1,
        purpose: "morrow.login.capsule/1",
        configurationDigest,
        currentKeyId: keyId,
        versions: [version],
      }),
      metadata: {
        keyId,
        encryptFromMs: version.encryptFromMs,
        encryptUntilMs: version.encryptUntilMs,
        decryptUntilMs: version.decryptUntilMs,
        configurationDigest,
      },
    };
  } finally {
    material.fill(0);
  }
}

export async function runLoginKeyring(argv, options = {}) {
  const { config, out } = parseKeyringArguments(argv);
  checkKeyringDestination(out, options);
  const { tsImport } = await import("tsx/esm/api");
  const { parseLoginConfiguration } = await tsImport(
    "../packages/identity/src/standalone-login-protocol.ts",
    import.meta.url,
  );
  const { parseManagedLoginKeyring } = await tsImport(
    "../packages/identity/src/managed-login-capsule.ts",
    import.meta.url,
  );
  let configuration;
  try {
    configuration = await parseLoginConfiguration(readFileSync(config, "utf8"));
  } catch {
    fail("LOGIN_KEYRING_CONFIGURATION_INVALID");
  }
  const { keyringJson, metadata } = buildLoginKeyring(configuration.configurationDigest);
  parseManagedLoginKeyring(keyringJson, configuration.configurationDigest);
  const descriptor = openSync(
    out,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, JSON.stringify({ LOGIN_CAPSULE_KEYRING: keyringJson }) + "\n");
  } finally {
    closeSync(descriptor);
  }
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runLoginKeyring(process.argv.slice(2)).then(
    (metadata) => console.log(JSON.stringify(metadata)),
    (error) => {
      // Fixed codes only; never echo paths, configuration or material.
      const code = /^LOGIN_KEYRING_[A-Z_]+$/.test(error?.message)
        ? error.message
        : "LOGIN_KEYRING_FAILED";
      console.error(code);
      process.exit(1);
    },
  );
