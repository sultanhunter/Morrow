// The owner-run vault script (M2 brief "Owner actions" 3; ADR-0022 item 7; spine §4).
// It runs on the owner's machine only and never on CI, an agent or a hosted host:
//
//   npm run vault -- kek --out <file>
//       Writes a new KEK (32 random bytes, 64 lowercase hex characters) to a new 0600 file
//       outside the repository and prints only its fingerprint. Keep that file as the
//       offline copy and place its content as the broker secret MORROW_VAULT_KEK_V1
//       (morrow_put, then staging:put-secret).
//   npm run vault -- seal-app-secret --environment <development|staging>
//       --app-key <key> --version <n> --kek-file <file> [--kek-version <n>] --out <file>
//       Reads one Shopify app client secret from stdin (not echoed on a terminal), seals it
//       with the broker's own vault module under the KEK and writes the envelope to a new
//       0600 file. The envelope holds only ciphertext and metadata. Production is refused
//       until the production custody ADR (ADR-0007 item 9; ADR-0022 item 7) is accepted.
//       A secret with any control character (a typed correction such as Backspace, which a
//       terminal without line editing passes through) is refused, and Ctrl-C aborts.
//   npm run vault -- check-envelope --kek-file <file> --envelope <file>
//       Opens an envelope with the KEK and prints only "envelope opens".
//
// The envelope is applied by the administrator's runner, as morrow_work_owner inside its
// own transaction (the ADR-0020 runner shape), with `appSecretPutStatement`: the runner
// rolls back unless app_secret_put stores exactly the envelope's version, because the
// additional data binds that version. No secret, KEK or envelope byte is ever printed, and
// no file is ever written inside the repository.
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./artifacts.mjs";
import {
  createVaultKeyring,
  openVaultRecord,
  sealVaultRecord,
  vaultBytesHex,
  vaultEnvironments,
  vaultHexBytes,
  vaultLimits,
} from "../apps/broker/src/vault.ts";

const fail = (code) => Error("VAULT_SCRIPT_" + code);
const appKeyPattern = /^[a-z0-9][a-z0-9-]{2,62}$/;
const kekPattern = /^[0-9a-f]{64}$/;
const envelopeKind = "morrow.vault.app_secret_envelope";
const usage =
  "usage: vault.mjs kek --out <file> | seal-app-secret --environment <env> --app-key <key> --version <n> --kek-file <file> [--kek-version <n>] --out <file> | check-envelope --kek-file <file> --envelope <file>";

export function parseVaultArguments(argv) {
  const [command, ...rest] = argv;
  const allowed = {
    kek: ["out"],
    "seal-app-secret": ["environment", "app-key", "version", "kek-file", "kek-version", "out"],
    "check-envelope": ["kek-file", "envelope"],
  }[command];
  if (!allowed) throw fail("USAGE");
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = /^--([a-z-]+)$/.exec(rest[i] ?? "")?.[1];
    const value = rest[i + 1];
    if (!flag || !allowed.includes(flag) || Object.hasOwn(options, flag) || value === undefined)
      throw fail("USAGE");
    options[flag] = value;
  }
  const required = allowed.filter((flag) => flag !== "kek-version");
  if (required.some((flag) => !Object.hasOwn(options, flag))) throw fail("USAGE");
  return { command, options };
}

// A path outside the repository: a secret or envelope never lands in the checkout. Both the
// path as given and its real path (symbolic links resolved, through the parent directory
// for a file not yet written) must lie outside the real repository root. "Outside" is a
// parent step ("..", or ".." and a separator) or another root, so a name inside the
// checkout that merely starts with ".." (such as "..kek") is inside.
const outside = (base, candidate) => {
  const inside = relative(base, candidate);
  return inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside);
};
function realPath(absolute) {
  try {
    return realpathSync(absolute);
  } catch {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  }
}
export function outsideRepository(path, root = repositoryRoot) {
  const absolute = resolve(path);
  let real, realRoot;
  try {
    real = realPath(absolute);
    realRoot = realpathSync(resolve(root));
  } catch {
    throw fail("PATH_INVALID");
  }
  if (!outside(resolve(root), absolute) || !outside(realRoot, real))
    throw fail("PATH_INSIDE_REPOSITORY");
  return real;
}
// A new file, created exclusively with mode 0600.
function writeNew(path, text) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
// The owner's KEK file: a regular file readable by the owner only, holding exactly one KEK.
export function readKekFile(path) {
  const absolute = outsideRepository(path);
  const stat = statSync(absolute);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw fail("KEK_FILE_UNSAFE");
  const text = readFileSync(absolute, "utf8").replace(/\n$/, "");
  if (!kekPattern.test(text)) throw fail("KEK_INVALID");
  return text;
}
export const kekFingerprint = (kek) =>
  createHash("sha256")
    .update("morrow.vault.kek.fingerprint.v1:" + kek)
    .digest("hex")
    .slice(0, 16);

export function generateKek(out, random) {
  const absolute = outsideRepository(out);
  const kek = vaultBytesHex(random(vaultLimits.keyBytes));
  if (!kekPattern.test(kek)) throw fail("KEK_INVALID");
  writeNew(absolute, kek + "\n");
  return { fingerprint: kekFingerprint(kek) };
}

const positive = (value, maximum) => {
  if (!/^[1-9][0-9]*$/.test(value ?? "") || Number(value) > maximum) throw fail("USAGE");
  return Number(value);
};
// C0 and C1 control characters and DEL: never part of a client secret.
const controlCharacter = /[\u0000-\u001f\u007f-\u009f]/;
export async function sealAppSecret(options, secret) {
  // Production custody needs its own ADR (ADR-0007 item 9); until then no production
  // envelope is made.
  if (options.environment === "production") throw fail("PRODUCTION_HELD");
  if (!vaultEnvironments.includes(options.environment)) throw fail("USAGE");
  if (!appKeyPattern.test(options["app-key"] ?? "")) throw fail("USAGE");
  const version = positive(options.version, Number.MAX_SAFE_INTEGER);
  const kekVersion = positive(options["kek-version"] ?? "1", vaultLimits.kekVersionMax);
  const bytes = new TextEncoder().encode(secret);
  if (
    bytes.length < 1 ||
    bytes.length > vaultLimits.plaintextMaxBytes ||
    controlCharacter.test(secret)
  ) {
    bytes.fill(0);
    throw fail("SECRET_INVALID");
  }
  const keyring = await createVaultKeyring(
    options.environment,
    new Map([[kekVersion, readKekFile(options["kek-file"])]]),
  );
  const ref = { kind: "app_secret", appKey: options["app-key"], provider: "shopify", version };
  const envelope = await sealVaultRecord(keyring, ref, bytes);
  bytes.fill(0);
  return {
    schemaVersion: 1,
    kind: envelopeKind,
    environment: options.environment,
    appKey: ref.appKey,
    version,
    kekVersion: envelope.kekVersion,
    wrappedKeyHex: vaultBytesHex(envelope.wrappedKey),
    sealedValueHex: vaultBytesHex(envelope.sealedValue),
  };
}
export function parseEnvelope(text) {
  let e;
  try {
    e = JSON.parse(text);
  } catch {
    throw fail("ENVELOPE_INVALID");
  }
  if (
    !e ||
    Object.keys(e).sort().join(",") !==
      "appKey,environment,kekVersion,kind,schemaVersion,sealedValueHex,version,wrappedKeyHex" ||
    e.schemaVersion !== 1 ||
    e.kind !== envelopeKind ||
    !vaultEnvironments.includes(e.environment) ||
    !appKeyPattern.test(e.appKey) ||
    !Number.isSafeInteger(e.version) ||
    e.version < 1 ||
    !Number.isSafeInteger(e.kekVersion) ||
    e.kekVersion < 1 ||
    e.kekVersion > vaultLimits.kekVersionMax
  )
    throw fail("ENVELOPE_INVALID");
  vaultHexBytes(e.wrappedKeyHex, vaultLimits.wrappedKeyBytes, vaultLimits.wrappedKeyBytes);
  vaultHexBytes(e.sealedValueHex, vaultLimits.sealedMinBytes, vaultLimits.sealedMaxBytes);
  return e;
}
export async function checkEnvelope(envelope, kek) {
  const keyring = await createVaultKeyring(
    envelope.environment,
    new Map([[envelope.kekVersion, kek]]),
  );
  const plaintext = await openVaultRecord(
    keyring,
    { kind: "app_secret", appKey: envelope.appKey, provider: "shopify", version: envelope.version },
    {
      kekVersion: envelope.kekVersion,
      wrappedKey: vaultHexBytes(envelope.wrappedKeyHex, 60, 60),
      sealedValue: vaultHexBytes(envelope.sealedValueHex, 29, 4124),
    },
  );
  plaintext.fill(0);
  return true;
}
/**
 * The administrator runner's one statement for an envelope, run as morrow_work_owner in
 * its own transaction: it commits only when the outcome is `stored` at `expectedVersion`.
 */
export function appSecretPutStatement(envelope) {
  const e = parseEnvelope(JSON.stringify(envelope));
  return Object.freeze({
    text: "SELECT outcome,version FROM morrow_vault.app_secret_put($1,$2,$3,$4)",
    values: Object.freeze([e.appKey, String(e.kekVersion), e.wrappedKeyHex, e.sealedValueHex]),
    expectedVersion: String(e.version),
  });
}

// One secret line from stdin: not echoed on a terminal, at most 4096 bytes. A terminal is
// read in raw mode (no echo), so it has no line editing: Ctrl-C aborts, and any other
// control byte (a Backspace) stays in the text, where sealAppSecret refuses it.
export async function readSecret(stdin = process.stdin) {
  const chunks = [];
  let size = 0;
  if (stdin.isTTY) {
    process.stderr.write("Shopify app client secret (not shown): ");
    stdin.setRawMode(true);
  }
  try {
    for await (const chunk of stdin) {
      if (stdin.isTTY && chunk.includes(3)) {
        for (const held of chunks) held.fill(0);
        chunk.fill(0);
        throw fail("ABORTED");
      }
      chunks.push(chunk);
      size += chunk.length;
      if (size > vaultLimits.plaintextMaxBytes + 2) throw fail("SECRET_INVALID");
      if (stdin.isTTY && chunk.includes(13)) break;
    }
  } finally {
    if (stdin.isTTY) {
      stdin.setRawMode(false);
      process.stderr.write("\n");
    }
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n?$/, "")
    .replace(/\r$/, "");
}

export async function main(argv = process.argv.slice(2), random) {
  const { command, options } = parseVaultArguments(argv);
  const { randomBytes } = await import("node:crypto");
  if (command === "kek") {
    const { fingerprint } = generateKek(options.out, random ?? ((n) => randomBytes(n)));
    console.log(JSON.stringify({ written: "kek", fingerprint }));
    return;
  }
  if (command === "seal-app-secret") {
    const out = outsideRepository(options.out);
    const envelope = await sealAppSecret(options, await readSecret());
    writeNew(out, JSON.stringify(envelope) + "\n");
    console.log(
      JSON.stringify({
        written: "envelope",
        environment: envelope.environment,
        appKey: envelope.appKey,
        version: envelope.version,
        kekVersion: envelope.kekVersion,
        kekFingerprint: kekFingerprint(readKekFile(options["kek-file"])),
      }),
    );
    return;
  }
  const envelope = parseEnvelope(readFileSync(outsideRepository(options.envelope), "utf8"));
  await checkEnvelope(envelope, readKekFile(options["kek-file"]));
  console.log("envelope opens");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    // Fixed codes only: never a value, path content or stack.
    const code = /^(VAULT_SCRIPT_[A-Z_]+|VAULT_[A-Z_]+)$/.exec(error?.message ?? "")?.[1];
    console.error(code ?? "VAULT_SCRIPT_FAILED");
    if (code === "VAULT_SCRIPT_USAGE") console.error(usage);
    process.exitCode = 1;
  });
