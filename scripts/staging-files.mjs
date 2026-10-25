// Owner credential files for staging (P04.T01i D4). They live in
// ~/.config/morrow/staging (mode 0700, the tmp/ subdirectory too); every file is 0600,
// owned by the operator, a regular file and never a symlink. The tools read them
// in-process and report metadata only (existence, mode, owner, non-emptiness and the
// boolean result of a format check). No value, path, parser message or byte count of a
// secret is ever returned to a caller that prints. Agents never read these files into
// their context; tests use temporary directories with planted marker files.
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { StagingError } from "./staging-common.mjs";
import { cloudflareTokenFormat } from "./staging-token.mjs";

export const credentialDirectory = (home) => join(home, ".config", "morrow", "staging");
const maximumBytes = 16384;
const uid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

// A Neon owner connection string for the direct (never -pooler) endpoint of the bound
// branch. Parsing never throws a foreign error: Node's ERR_INVALID_URL carries `input`.
export const neonEndpointHost =
  /^ep-[a-z0-9-]+\.(?:c-[0-9]+\.)?[a-z0-9-]+\.(aws|azure)\.neon\.tech$/;
export function parseOwnerUrl(text, { formatOnly = false } = {}) {
  let url;
  try {
    if (typeof text !== "string" || text.length > 2048 || /[\s]/.test(text)) throw 0;
    url = new URL(text);
  } catch {
    throw new StagingError("STAGING_OWNER_URL_INVALID");
  }
  const params = [...url.searchParams.entries()];
  let user, password, database;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new StagingError("STAGING_OWNER_URL_INVALID");
  }
  if (
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(user) ||
    password.length < 8 ||
    password.length > 1024 ||
    /[\x00-\x20\x7f]/.test(password) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
    !(url.port === "" || url.port === "5432") ||
    url.hash !== "" ||
    !params.every(
      ([k, v]) =>
        (k === "sslmode" && v === "require") || (k === "channel_binding" && v === "require"),
    ) ||
    new Set(params.map(([k]) => k)).size !== params.length
  )
    throw new StagingError("STAGING_OWNER_URL_INVALID");
  const host = url.hostname;
  // The format check accepts a -pooler host so that its use is refused by name.
  if (!formatOnly && host.split(".")[0].includes("-pooler"))
    throw new StagingError("STAGING_OWNER_URL_POOLER");
  if (!neonEndpointHost.test(host) || host.length > 253)
    throw new StagingError("STAGING_OWNER_URL_INVALID");
  return Object.freeze({ host, user, password, database });
}

const jsonKeys = (text, keys) => {
  try {
    const value = JSON.parse(text);
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join() === [...keys].sort().join() &&
      Object.values(value).every((v) => typeof v === "string" && v.length > 0)
    );
  } catch {
    return false;
  }
};

// M2 PR-1 (ADR-0022 item 7): the owner file of one vault KEK version, `vault-kek-v<n>` for
// MORROW_VAULT_KEK_V<n>, or null for any other name. The owner writes it with
// `npm run vault -- kek --out ~/.config/morrow/staging/vault-kek-v<n>` (64 lowercase hex
// characters in a new 0600 file) and keeps an offline copy; the tools only read it.
export function vaultKekFile(name) {
  const match = /^MORROW_VAULT_KEK_V([1-9][0-9]{0,2})$/.exec(String(name));
  return match ? "vault-kek-v" + match[1] : null;
}

// The closed set of files the tools know. `required` files must exist for
// secrets-status to pass; transient ones are reported and expected to be removed. Every
// vault KEK among the broker's names has its own required owner file, and so does each
// Stripe secret among them: only while the Stripe switch is on (M5; owner decision (c),
// 2026-10-21), so while it is off the tools neither require nor read a Stripe file.
const stripeFileSpecs = Object.freeze({
  // M5 PR-1 (ADR-0022 items 7 and 12): the Stripe restricted test key (never sk_, never
  // live) and the webhook endpoint's signing secret, placed by the owner with morrow_put.
  "stripe-restricted-key": {
    required: true,
    secret: "STRIPE_RESTRICTED_KEY",
    format: (v) => /^rk_test_[A-Za-z0-9]{16,250}$/.test(v),
  },
  "stripe-webhook-secret": {
    required: true,
    secret: "STRIPE_WEBHOOK_SECRET",
    format: (v) => /^whsec_[A-Za-z0-9+/=_-]{16,256}$/.test(v),
  },
});
// Build order PR 7 (ADR-0029 item 3; ADR-0035 item 6): the E2B API key, placed by the owner
// with morrow_put. Required while the runtime switch is on or cleanup-only (E2B_API_KEY among
// the broker's names); while it is off an optional file (E2B_API_KEY among the optional
// names): not required, not transient, read only by `put-secret E2B_API_KEY
// --while-runtime-off`, and checked for format when present. The format is
// packages/identity/src/broker-protocol.ts e2bKeyPattern (drift-tested).
export const e2bKeyFormat = /^e2b_[A-Za-z0-9]{20,128}$/;
const runtimeFileSpec = (required) => ({
  required,
  secret: "E2B_API_KEY",
  format: (v) => e2bKeyFormat.test(v),
});
// M3 PR-2's model-provider switch (ADR-0022 items 7 and 10; ADR-0035 items 4 and 8.2): the
// Anthropic Console API key of the owner's workspace `Morrow`, placed by the owner with
// morrow_put as `anthropic-api-key`. Required only while the switch is on (ANTHROPIC_API_KEY
// among the broker's names); while it is off there is no spec, so the tools neither require
// nor read the file, as for Stripe. The format is packages/identity/src/broker-protocol.ts
// anthropicKeyPattern (drift-tested), the shape the broker itself admits.
export const anthropicKeyFormat = /^sk-ant-api03-[A-Za-z0-9_-]{80,200}$/;
const modelFileSpec = Object.freeze({
  required: true,
  secret: "ANTHROPIC_API_KEY",
  format: (v) => anthropicKeyFormat.test(v),
});
export const shopifyAppSecretFile = "shopify-app-secret";
export function stagingFileSpecs({ brokerSecretNames, optionalSecretNames = [] }) {
  return Object.freeze({
    "workos-api-key": {
      required: true,
      secret: "WORKOS_API_KEY",
      format: (v) => /^sk_test_[A-Za-z0-9]{16,256}$/.test(v),
    },
    "turnstile-secret": {
      required: true,
      secret: "TURNSTILE_SECRET_KEY",
      format: (v) => /^0x[0-9A-Za-z_-]{20,128}$/.test(v),
    },
    ...Object.fromEntries(
      Object.entries(stripeFileSpecs).filter(([, spec]) => brokerSecretNames.includes(spec.secret)),
    ),
    ...(brokerSecretNames.includes(modelFileSpec.secret)
      ? { "anthropic-api-key": modelFileSpec }
      : {}),
    ...(brokerSecretNames.includes("E2B_API_KEY")
      ? { "e2b-api-key": runtimeFileSpec(true) }
      : optionalSecretNames.includes("E2B_API_KEY")
        ? { "e2b-api-key": runtimeFileSpec(false) }
        : {}),
    ...Object.fromEntries(
      brokerSecretNames
        .filter((name) => vaultKekFile(name) !== null)
        .map((name) => [
          vaultKekFile(name),
          { required: true, secret: name, format: (v) => /^[0-9a-f]{64}$/.test(v) },
        ]),
    ),
    "neon-owner-url": {
      required: true,
      // The user is checked against the administrator where the URL is used.
      format: (v) => {
        try {
          return parseOwnerUrl(v, { formatOnly: true }) !== null;
        } catch {
          return false;
        }
      },
    },
    "neon-project-api-key": {
      required: true,
      format: (v) => /^(napi_)?[A-Za-z0-9]{40,128}$/.test(v),
    },
    "cloudflare-operator-token": { required: true, format: (v) => cloudflareTokenFormat.test(v) },
    // Placed in GitHub with `gh secret set … < file`, then deleted (D4).
    "cloudflare-ci-token": {
      required: false,
      transient: true,
      format: (v) => cloudflareTokenFormat.test(v),
    },
    // v1 PR 1: the owner's Shopify app client secret, when the owner places it with
    // morrow_put instead of typing it at `staging:shopify-app-register`'s hidden prompt.
    // That command reads it once, seals it and deletes it after the vault stored it.
    [shopifyAppSecretFile]: {
      required: false,
      transient: true,
      format: (v) => /^[A-Za-z0-9_-]{16,256}$/.test(v),
    },
    "tmp/broker-secrets.json": {
      required: false,
      transient: true,
      format: (v) => jsonKeys(v, brokerSecretNames),
    },
    "tmp/api-secrets.json": {
      required: false,
      transient: true,
      format: (v) => jsonKeys(v, ["LOGIN_CAPSULE_KEYRING"]),
    },
  });
}

const modeOf = (stat) => stat.mode & 0o777;
const octal = (mode) => "0" + mode.toString(8).padStart(3, "0");

// Directory facts, never its listing.
export function inspectDirectory(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return Object.freeze({ exists: false, ok: false });
  }
  const facts = {
    exists: true,
    symlink: stat.isSymbolicLink(),
    directory: stat.isDirectory(),
    mode: octal(modeOf(stat)),
    owner: stat.uid === uid(),
  };
  facts.ok = !facts.symlink && facts.directory && modeOf(stat) === 0o700 && facts.owner;
  return Object.freeze(facts);
}
export function requireDirectory(path, code = "STAGING_CREDENTIAL_DIRECTORY") {
  const facts = inspectDirectory(path);
  if (!facts.ok) throw new StagingError(code, { exists: facts.exists, mode: facts.mode ?? null });
}

// Opens one file without following a symlink and re-checks the open descriptor, so a
// swapped path cannot redirect the read. Returns the text, or throws a fixed code.
function readChecked(path, name) {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    throw new StagingError("STAGING_FILE_MISSING", { file: name });
  }
  if (before.isSymbolicLink() || !before.isFile())
    throw new StagingError("STAGING_FILE_NOT_REGULAR", { file: name });
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new StagingError("STAGING_FILE_UNREADABLE", { file: name });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev)
      throw new StagingError("STAGING_FILE_NOT_REGULAR", { file: name });
    if (modeOf(stat) !== 0o600)
      throw new StagingError("STAGING_FILE_MODE", { file: name, mode: octal(modeOf(stat)) });
    if (stat.uid !== uid()) throw new StagingError("STAGING_FILE_OWNER", { file: name });
    if (stat.size === 0) throw new StagingError("STAGING_FILE_EMPTY", { file: name });
    if (stat.size > maximumBytes) throw new StagingError("STAGING_FILE_TOO_LARGE", { file: name });
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const text = buffer.subarray(0, offset).toString("utf8");
    buffer.fill(0);
    // A single trailing newline (neonctl's redirect) is not part of the value.
    return text.endsWith("\n") ? text.slice(0, -1) : text;
  } finally {
    closeSync(fd);
  }
}

// Reads one known credential file and checks its format; the value goes only to the
// in-process caller that needs it.
export function readCredentialFile(directory, name, specs) {
  const spec = specs[name];
  if (!spec) throw new StagingError("STAGING_FILE_UNKNOWN");
  requireDirectory(directory);
  if (name.startsWith("tmp/")) requireDirectory(join(directory, "tmp"), "STAGING_TMP_DIRECTORY");
  const value = readChecked(join(directory, name), name);
  let valid = false;
  try {
    valid = spec.format(value) === true;
  } catch {
    valid = false;
  }
  if (!valid) throw new StagingError("STAGING_FILE_FORMAT", { file: name });
  return value;
}

// Metadata only: never the value, its length or a parser message.
export function inspectCredentialFile(directory, name, specs) {
  const spec = specs[name];
  const path = join(directory, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return Object.freeze({ file: name, exists: false, required: spec.required === true });
  }
  const facts = {
    file: name,
    exists: true,
    required: spec.required === true,
    transient: spec.transient === true,
    symlink: stat.isSymbolicLink(),
    regular: stat.isFile(),
    mode: octal(modeOf(stat)),
    owner: stat.uid === uid(),
    nonEmpty: stat.size > 0,
    format: false,
  };
  if (!facts.symlink && facts.regular && modeOf(stat) === 0o600 && facts.owner && facts.nonEmpty)
    try {
      facts.format = spec.format(readChecked(path, name)) === true;
    } catch {
      facts.format = false;
    }
  facts.ok =
    !facts.symlink &&
    facts.regular &&
    facts.mode === "0600" &&
    facts.owner &&
    facts.nonEmpty &&
    facts.format;
  return Object.freeze(facts);
}

// A new owner-only file (O_EXCL, O_NOFOLLOW, 0600) in a checked directory. It is opened
// before any effect, so an existing file stops the command first; `abandon` unlinks it.
export function createOwnerFile(directory, name) {
  requireDirectory(directory);
  if (name.startsWith("tmp/")) requireDirectory(join(directory, "tmp"), "STAGING_TMP_DIRECTORY");
  if (!/^(tmp\/)?[a-z0-9-]+(\.json)?$/.test(name)) throw new StagingError("STAGING_FILE_UNKNOWN");
  const path = join(directory, name);
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw new StagingError(
      error?.code === "EEXIST" ? "STAGING_FILE_EXISTS" : "STAGING_FILE_UNWRITABLE",
      {
        file: name,
      },
    );
  }
  let open = true;
  return Object.freeze({
    file: name,
    write(text) {
      if (!open) throw new StagingError("STAGING_FILE_UNWRITABLE", { file: name });
      try {
        const bytes = Buffer.from(text, "utf8");
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        bytes.fill(0);
        fsyncSync(fd);
      } catch {
        throw new StagingError("STAGING_FILE_UNWRITABLE", { file: name });
      } finally {
        closeSync(fd);
        open = false;
      }
    },
    abandon() {
      if (open) {
        closeSync(fd);
        open = false;
      }
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    },
  });
}

// The non-secret rotation record: secret name -> {rotatedAt, worker, versionId}. It is
// the source of secrets-status ages and of the rollback limits (no rollback across a
// rotation). Written through a 0600 temporary file and an atomic rename.
const rotationFile = "rotation-record.json";
export function readRotationRecord(directory) {
  let text;
  try {
    text = readChecked(join(directory, rotationFile), rotationFile);
  } catch (error) {
    if (error instanceof StagingError && error.code === "STAGING_FILE_MISSING")
      return Object.freeze({ schemaVersion: 1, secrets: {} });
    throw new StagingError("STAGING_ROTATION_RECORD_INVALID");
  }
  try {
    const value = JSON.parse(text);
    if (value?.schemaVersion !== 1 || typeof value.secrets !== "object" || value.secrets === null)
      throw 0;
    for (const [name, entry] of Object.entries(value.secrets))
      if (
        !/^[A-Z][A-Z0-9_]{2,63}$/.test(name) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(entry?.rotatedAt) ||
        !["broker", "api"].includes(entry?.worker) ||
        !(entry.versionId === null || /^[0-9a-f-]{36}$/.test(entry.versionId))
      )
        throw 0;
    return value;
  } catch {
    throw new StagingError("STAGING_ROTATION_RECORD_INVALID");
  }
}
export function recordRotation(directory, names, { worker, versionId, now }) {
  requireDirectory(directory);
  const record = readRotationRecord(directory);
  const rotatedAt = new Date(now).toISOString();
  const next = { schemaVersion: 1, secrets: { ...record.secrets } };
  for (const name of names)
    next.secrets[name] = { rotatedAt, worker, versionId: versionId ?? null };
  // A leftover from an interrupted write is replaced, never followed (O_NOFOLLOW below).
  try {
    if (!lstatSync(join(directory, "rotation-record-next")).isSymbolicLink())
      unlinkSync(join(directory, "rotation-record-next"));
  } catch {
    // Not present.
  }
  const handle = createOwnerFile(directory, "rotation-record-next");
  handle.write(JSON.stringify(next, null, 2) + "\n");
  try {
    renameSync(join(directory, "rotation-record-next"), join(directory, rotationFile));
  } catch {
    throw new StagingError("STAGING_ROTATION_RECORD_UNWRITABLE");
  }
  return next;
}
