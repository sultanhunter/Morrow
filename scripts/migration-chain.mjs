// The one migration chain (P04.T01i D3, ADR-0019 item 12, ADR-0020 item 5). It reads
// migrations/manifest.json, verifies every migration's sha256 and every pinned
// prerequisite's sha256 (the manifest's `prerequisites` rows, P03.T04e), and yields
// frozen entries {sequence, file, sha256, text, body, executeAs, prerequisites}. The
// staging runner (scripts/staging.mjs), the delivery checks and the tenant-conformance
// harness all read the chain through this module; nobody keeps a private file map.
//
// Pure helpers take bytes, never paths, so tests can feed synthetic chains. Failures are
// fixed codes only: no path, SQL or file content reaches an error message.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "./artifacts.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const executeAsRole = /^morrow_[a-z][a-z0-9_]{0,47}$/;
const sha256Hex = /^[0-9a-f]{64}$/;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A prerequisite entry is exactly {file, sha256}; any other key (say a `runAs`) denies
// rather than being silently ignored by the administrator-run consumer.
const isPrerequisiteEntry = (value) =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join() === "file,sha256" &&
  typeof value.file === "string" &&
  typeof value.sha256 === "string" &&
  sha256Hex.test(value.sha256);

// Pure: the caller passes migration SQL by file name and every prerequisite file's bytes by
// repository path. Every row names the restricted owner role it is applied under
// (`executeAs`). A row that needs administrator setup first lists pinned `prerequisites`
// ({file, sha256}) under prerequisiteDirectory; each prerequisite file belongs to exactly
// one row, and a passed prerequisite file that no row names denies.
export function inspectMigrations(
  manifest,
  files,
  prerequisites = {},
  { prerequisiteDirectory = "infra" } = {},
) {
  const errors = [];
  if (
    manifest?.schema_version !== 1 ||
    manifest.engine !== "postgresql17" ||
    !Array.isArray(manifest.migrations)
  )
    return ["INVALID_MIGRATION_MANIFEST"];
  const prerequisitePath = new RegExp(
    "^" + escapeRegExp(prerequisiteDirectory) + "/[a-z0-9-]+-prerequisites\\.sql$",
  );
  const prerequisiteFiles = new Set();
  const namedPrerequisites = new Set();
  let previous = 0;
  const names = new Set();
  for (const entry of manifest.migrations) {
    if (
      !Number.isInteger(entry?.sequence) ||
      entry.sequence <= previous ||
      typeof entry.file !== "string" ||
      !/^\d{4}\.[a-z0-9-]+\.sql$/.test(entry.file) ||
      names.has(entry.file) ||
      !entry.reviewRef
    )
      errors.push("INVALID_MIGRATION_RECORD");
    previous = entry?.sequence;
    names.add(entry?.file);
    const sql = Object.hasOwn(files, entry?.file) ? files[entry.file] : undefined;
    if (!sql) errors.push("MISSING_MIGRATION");
    else {
      if (sha256(sql) !== entry.sha256) errors.push("MIGRATION_CHECKSUM");
      if (!/^\s*BEGIN\s*;/i.test(sql) || !/COMMIT\s*;\s*$/i.test(sql))
        errors.push("MIGRATION_TRANSACTION_ENVELOPE");
    }
    if (typeof entry?.executeAs !== "string" || !executeAsRole.test(entry.executeAs))
      errors.push("INVALID_EXECUTE_AS");
    if (entry?.prerequisites !== undefined) {
      if (!Array.isArray(entry.prerequisites) || entry.prerequisites.length === 0)
        errors.push("INVALID_PREREQUISITE");
      else
        for (const prerequisite of entry.prerequisites) {
          const file = prerequisite?.file;
          if (typeof file === "string") namedPrerequisites.add(file);
          if (
            !isPrerequisiteEntry(prerequisite) ||
            !prerequisitePath.test(file) ||
            !Object.hasOwn(prerequisites, file) ||
            !(typeof prerequisites[file] === "string" || prerequisites[file] instanceof Uint8Array)
          ) {
            errors.push("INVALID_PREREQUISITE");
            continue;
          }
          if (prerequisiteFiles.has(file)) errors.push("DUPLICATE_PREREQUISITE");
          prerequisiteFiles.add(file);
          if (sha256(prerequisites[file]) !== prerequisite.sha256)
            errors.push("PREREQUISITE_CHECKSUM");
        }
    }
  }
  if (Object.keys(files).some((name) => !names.has(name))) errors.push("UNREVIEWED_MIGRATION_FILE");
  if (Object.keys(prerequisites).some((path) => !namedPrerequisites.has(path)))
    errors.push("UNREVIEWED_PREREQUISITE_FILE");
  return [...new Set(errors)];
}

// Top-level statements outside every quote, dollar quote and comment, split the way psql
// splits them: '…' (with '' escapes), E'…' (with \ escapes), "…", $tag$…$tag$, -- and
// nested /* */, parentheses, and psql's BEGIN/CASE … END depth inside
// CREATE [OR REPLACE] FUNCTION|PROCEDURE (SQL-standard BEGIN ATOMIC bodies, as in 0014).
export function topLevelStatements(text) {
  const statements = [];
  let current = "";
  let i = 0;
  let parens = 0;
  let depth = 0;
  let words = [];
  const n = text.length;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
    parens = 0;
    depth = 0;
    words = [];
  };
  const routine = () =>
    words[0] === "create" &&
    (words[1] === "function" ||
      words[1] === "procedure" ||
      (words[1] === "or" &&
        words[2] === "replace" &&
        (words[3] === "function" || words[3] === "procedure")));
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (/[A-Za-z_]/.test(c) && !/[A-Za-z0-9_$]$/.test(current)) {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i, i + 128))[0];
      const lower = word.toLowerCase();
      if (words.length < 4) words.push(lower);
      if (routine() && parens === 0) {
        if (lower === "begin") depth++;
        else if (lower === "case" && depth > 0) depth++;
        else if (lower === "end" && depth > 0) depth--;
      }
      current += word;
      i += word.length;
      continue;
    }
    if (c === "(") parens++;
    else if (c === ")" && parens > 0) parens--;
    if (c === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      current += " ";
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") (depth++, (i += 2));
        else if (text[i] === "*" && text[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
      if (depth) throw Error("MIGRATION_UNTERMINATED_TOKEN");
      current += " ";
    } else if (c === "'" || c === '"') {
      const escaped =
        c === "'" && /[eE]$/.test(current) && !/[A-Za-z0-9_$]$/.test(current.slice(0, -1));
      i++;
      for (;;) {
        if (i >= n) throw Error("MIGRATION_UNTERMINATED_TOKEN");
        if (escaped && text[i] === "\\") i += 2;
        else if (text[i] === c && text[i + 1] === c) i += 2;
        else if (text[i] === c) {
          i++;
          break;
        } else i++;
      }
      current += " ";
    } else if (c === "$" && !/[A-Za-z0-9_$]$/.test(current)) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 66));
      if (!tag) {
        current += c;
        i++;
        continue;
      }
      const close = text.indexOf(tag[0], i + tag[0].length);
      if (close === -1) throw Error("MIGRATION_UNTERMINATED_TOKEN");
      i = close + tag[0].length;
      current += " $body$ ";
    } else if (c === ";" && parens === 0 && depth === 0) {
      push();
      i++;
    } else {
      current += c;
      i++;
    }
  }
  push();
  return statements;
}

// Statements a migration body may never contain at top level: anything that ends, opens
// or nests a transaction, or the plain forms that change the role or session identity
// the runner set. This is an early refusal, not the control: dynamic SQL (EXECUTE in a DO
// block) can still change the role, so the runner checks current_user and session_user
// at the end of every body, inside its transaction (staging-runner.mjs applyEntry).
const forbiddenTopLevel = [
  /^(BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\b/i,
  /^PREPARE\s+TRANSACTION\b/i,
  /^(SET|RESET)\s+(LOCAL\s+|SESSION\s+)?(ROLE|SESSION\s+AUTHORIZATION)\b/i,
  /^RESET\s+ALL\b/i,
  /^DISCARD\b/i,
  /^\\/,
];
// set_config('role' | 'session_authorization', …) anywhere in the text, quoted or not:
// string literals are blanked in top-level statements, so this reads the raw body.
const forbiddenAnywhere =
  /\bset_config\s*\(\s*(E?'|\$[A-Za-z_]*\$)\s*(role|session_authorization)\s*('|\$)/i;

// The body the runner sends inside its own transaction: the file without its first line
// "BEGIN;" and its last line "COMMIT;" (P04.T01j D4). Anything else denies.
export function migrationBody(text) {
  if (typeof text !== "string") throw Error("MIGRATION_TRANSACTION_ENVELOPE");
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length < 3 || lines[0] !== "BEGIN;" || lines.at(-1) !== "COMMIT;")
    throw Error("MIGRATION_TRANSACTION_ENVELOPE");
  const body = lines.slice(1, -1).join("\n") + "\n";
  let statements;
  try {
    statements = topLevelStatements(body);
  } catch {
    throw Error("MIGRATION_TRANSACTION_CONTROL");
  }
  if (
    statements.some((s) => forbiddenTopLevel.some((pattern) => pattern.test(s))) ||
    forbiddenAnywhere.test(body)
  )
    throw Error("MIGRATION_TRANSACTION_CONTROL");
  return body;
}

// The roles a prerequisite file creates, in file order. The runner runs a prerequisite
// only when none exists and stops when some do (PREREQUISITE_PARTIAL).
export function prerequisiteRoles(text) {
  const roles = [...String(text).matchAll(/\bCREATE ROLE (morrow_[a-z0-9_]+)\b/g)].map((m) => m[1]);
  if (
    !roles.length ||
    new Set(roles).size !== roles.length ||
    !roles.every((r) => executeAsRole.test(r))
  )
    throw Error("PREREQUISITE_ROLES_INVALID");
  for (const statement of topLevelStatements(text))
    if (forbiddenTopLevel.some((pattern) => pattern.test(statement)))
      throw Error("PREREQUISITE_TRANSACTION_CONTROL");
  return Object.freeze(roles);
}

export class MigrationChainError extends Error {
  constructor(codes) {
    super("MIGRATION_CHAIN_INVALID");
    this.code = "MIGRATION_CHAIN_INVALID";
    this.codes = Object.freeze([...codes]);
  }
}

// Reads and verifies the chain under `root`. Every migration file in migrations/ and every
// infra/*-prerequisites.sql must be named by the manifest (no unreviewed bytes), every
// digest must match, and every body must pass migrationBody.
export function loadMigrationChain({ root = repositoryRoot } = {}) {
  let manifest, files, prerequisites;
  try {
    manifest = JSON.parse(readFileSync(join(root, "migrations/manifest.json"), "utf8"));
    files = Object.fromEntries(
      readdirSync(join(root, "migrations"))
        .filter((name) => name.endsWith(".sql"))
        .map((name) => [name, readFileSync(join(root, "migrations", name), "utf8")]),
    );
    prerequisites = Object.fromEntries(
      readdirSync(join(root, "infra"))
        .filter((name) => name.endsWith("-prerequisites.sql"))
        .map((name) => ["infra/" + name, readFileSync(join(root, "infra", name), "utf8")]),
    );
  } catch {
    throw new MigrationChainError(["MIGRATION_CHAIN_UNREADABLE"]);
  }
  const errors = inspectMigrations(manifest, files, prerequisites);
  if (errors.length) throw new MigrationChainError(errors);
  const chain = [];
  for (const entry of manifest.migrations) {
    let body, pinned;
    try {
      body = migrationBody(files[entry.file]);
      pinned = (entry.prerequisites ?? []).map((p) =>
        Object.freeze({
          file: p.file,
          sha256: p.sha256,
          text: prerequisites[p.file],
          roles: prerequisiteRoles(prerequisites[p.file]),
        }),
      );
    } catch (error) {
      throw new MigrationChainError([
        /^(MIGRATION|PREREQUISITE)_[A-Z_]+$/.test(error?.message)
          ? error.message
          : "MIGRATION_CHAIN_INVALID",
      ]);
    }
    chain.push(
      Object.freeze({
        sequence: entry.sequence,
        file: entry.file,
        sha256: entry.sha256,
        reviewRef: entry.reviewRef,
        executeAs: entry.executeAs,
        text: files[entry.file],
        body,
        prerequisites: Object.freeze(pinned),
      }),
    );
  }
  return Object.freeze(chain);
}

// The ledger's view of one entry: exactly the columns morrow_migrations.applied compares.
export const ledgerRecord = (entry) =>
  Object.freeze({
    sequence: entry.sequence,
    file: entry.file,
    sha256: entry.sha256,
    executeAs: entry.executeAs,
    prerequisites: entry.prerequisites.map((p) => ({ file: p.file, sha256: p.sha256 })),
  });

// STAGING_SCHEMA_HEAD (P04.T01i D2 gate 3): sha256 over the ordered
// (sequence, file, sha256, executeAs, prerequisites) list in fixed key order.
export function schemaHead(chain) {
  return sha256(
    JSON.stringify(
      chain.map((entry) => {
        const r = ledgerRecord(entry);
        return [
          r.sequence,
          r.file,
          r.sha256,
          r.executeAs,
          r.prerequisites.map((p) => [p.file, p.sha256]),
        ];
      }),
    ),
  );
}
